import AppKit
import CaptureCore
import ServiceManagement
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
  let store: CaptureStore
  @Published var settings: CaptureCore.Settings
  @Published var draft: Draft
  @Published var history: [SavedCapture] = []
  @Published var saving = false
  @Published var connecting = false
  @Published var error: String?
  @Published var settingsError: String?
  @Published var saved = false
  @Published var showingHistory = false
  @Published var loginItemStatus = SMAppService.mainApp.status
  @Published var loginItemError: String?
  var presentSettings: (() -> Void)?
  private var client: APIClient?

  var launchAtLogin: Bool {
    get { loginItemStatus == .enabled }
    set { setLaunchAtLogin(newValue) }
  }

  init(store: CaptureStore) {
    self.store = store
    settings = Settings()
    draft = Draft()
    do {
      settings = try store.read("settings", default: Settings())
      draft = try store.read("draft", default: Draft())
      if let account = settings.accountKey { history = try store.history(for: account) }
    } catch { self.error = "Saved data could not be opened. \(error.localizedDescription)" }
  }

  func configureLoginItem() {
    refreshLoginItemStatus()
    guard !UserDefaults.standard.bool(forKey: "loginItemConfigured") else { return }
    UserDefaults.standard.set(true, forKey: "loginItemConfigured")
    if loginItemStatus != .enabled && loginItemStatus != .requiresApproval {
      setLaunchAtLogin(true)
    }
  }

  func refreshLoginItemStatus() {
    loginItemStatus = SMAppService.mainApp.status
  }

  func setLaunchAtLogin(_ enabled: Bool) {
    let service = SMAppService.mainApp
    loginItemError = nil
    UserDefaults.standard.set(true, forKey: "loginItemConfigured")
    do {
      if enabled {
        if service.status == .requiresApproval {
          SMAppService.openSystemSettingsLoginItems()
        } else if service.status != .enabled {
          try service.register()
        }
      } else if service.status == .enabled || service.status == .requiresApproval {
        try service.unregister()
      }
    } catch {
      loginItemError = "Could not change launch at login. \(error.localizedDescription)"
    }
    refreshLoginItemStatus()
  }

  func persistDraft() {
    saved = false
    do { try store.write(draft, to: "draft") } catch {
      self.error = "The draft could not be kept on this Mac. \(error.localizedDescription)"
    }
  }

  func addFiles(_ urls: [URL]) {
    guard !saving else { return }
    showingHistory = false
    saved = false
    error = nil
    for url in urls {
      let access = url.startAccessingSecurityScopedResource()
      defer { if access { url.stopAccessingSecurityScopedResource() } }
      do { draft.attachments.append(try store.stage(url)) } catch {
        self.error = "Could not attach \(url.lastPathComponent). \(error.localizedDescription)"
      }
    }
    persistDraft()
  }

  func addImage(_ data: Data) {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(
      "Pasted image-\(UUID().uuidString.prefix(8)).png")
    do {
      try data.write(to: url)
      defer { try? FileManager.default.removeItem(at: url) }
      addFiles([url])
    } catch { self.error = "The image could not be attached." }
  }

  func chooseFiles() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = true
    panel.prompt = "Attach"
    if panel.runModal() == .OK { addFiles(panel.urls) }
  }

  func removeAttachment(_ id: UUID) {
    guard !saving, let attachment = draft.attachments.first(where: { $0.id == id }),
      !attachment.attached
    else { return }
    draft.attachments.removeAll { $0.id == id }
    persistDraft()
    store.removeStaged(attachment)
  }

  func latestScreenshot() {
    guard !saving else { return }
    showingHistory = false
    do {
      addFiles([try Screenshots.latest(in: URL(fileURLWithPath: settings.screenshotFolder))])
    } catch {
      self.error =
        "Could not load the last screenshot. Check the folder and its access in Settings. \(error.localizedDescription)"
    }
  }

  func discard() {
    guard !saving else { return }
    let alert = NSAlert()
    alert.messageText = "Discard this draft?"
    alert.informativeText =
      draft.bookmarkID == nil
      ? "The text and attached copies will be removed from this Mac."
      : "The partial note already on the server will remain there."
    alert.addButton(withTitle: "Discard")
    alert.addButton(withTitle: "Cancel")
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    do {
      try store.write(Draft(), to: "draft")
      draft.attachments.forEach(store.removeStaged)
      draft = Draft()
      error = nil
    } catch { self.error = error.localizedDescription }
  }

  func save() {
    guard !saving, !draft.isEmpty else { return }
    guard let server = settings.server, let user = settings.user else {
      presentSettings?()
      return
    }
    saving = true
    error = nil
    saved = false
    let currentDraft = draft
    Task {
      defer { saving = false }
      do {
        let api: APIClient
        if let client {
          api = client
        } else {
          let key = try await Task.detached { try Credentials.read(server: server) }.value
          guard let key else { throw CaptureError.message("Reconnect in Settings to save notes.") }
          api = APIClient(server: server, apiKey: key)
          client = api
        }
        _ = try await CaptureService(api: api, store: store).save(
          currentDraft, server: server, user: user)
        draft = Draft()
        saved = true
        if let account = settings.accountKey { history = try store.history(for: account) }
      } catch {
        if let recovered: Draft = try? store.read("draft", default: currentDraft) {
          draft = recovered
        }
        let prefix =
          draft.bookmarkID == nil
          ? "Save wasn’t confirmed. Check Karakeep before retrying. "
          : "The note is on the server; some changes may be unfinished. Save again to continue. "
        self.error = prefix + error.localizedDescription
      }
    }
  }

  func connect(address: String, key: String) {
    guard !connecting, !saving else { return }
    connecting = true
    settingsError = nil
    Task {
      defer { connecting = false }
      do {
        guard draft.bookmarkID == nil else {
          throw CaptureError.message(
            "Finish or discard the partial draft before changing accounts.")
        }
        let server = try ServerAddress(address)
        let trimmedKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let existingKey =
          trimmedKey.isEmpty
          ? try await Task.detached { try Credentials.read(server: server) }.value : nil
        guard let apiKey = trimmedKey.isEmpty ? existingKey : trimmedKey, !apiKey.isEmpty else {
          throw CaptureError.message("Enter an API key from Karakeep Settings → API Keys.")
        }
        let api = APIClient(server: server, apiKey: apiKey)
        let user = try await api.currentUser()
        try await Task.detached { try Credentials.save(apiKey, server: server) }.value
        var next = settings
        next.server = server
        next.user = user
        try store.write(next, to: "settings")
        settings = next
        client = api
        history = try store.history(for: next.accountKey!)
      } catch { settingsError = error.localizedDescription }
    }
  }

  func disconnect() {
    guard !connecting, !saving, let server = settings.server else { return }
    guard draft.bookmarkID == nil else {
      settingsError = "Finish or discard the partial draft first."
      return
    }
    connecting = true
    Task {
      defer { connecting = false }
      do {
        try await Task.detached { try Credentials.delete(server: server) }.value
        var next = settings
        next.server = nil
        next.user = nil
        try store.write(next, to: "settings")
        settings = next
        client = nil
        history = []
      } catch { settingsError = error.localizedDescription }
    }
  }

  func chooseScreenshotFolder() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.directoryURL = URL(fileURLWithPath: settings.screenshotFolder)
    panel.prompt = "Choose"
    guard panel.runModal() == .OK, let url = panel.url else { return }
    do {
      var next = settings
      next.screenshotFolder = url.path
      try store.write(next, to: "settings")
      settings = next
    } catch { settingsError = error.localizedDescription }
  }
}
