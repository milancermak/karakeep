import AppKit
import CaptureCore
import ServiceManagement
import SwiftUI

struct CaptureView: View {
  @ObservedObject var model: AppModel
  let dismiss: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("Karakeep").font(.headline)
        Spacer()
        Picker("View", selection: $model.showingHistory) {
          Text("Note").tag(false)
          Text("Recent").tag(true)
        }
        .pickerStyle(.segmented).labelsHidden().frame(width: 150)
      }.padding(16)
      Divider()
      if model.showingHistory { recent } else { composer }
    }
    .frame(width: 440, height: 470)
    .background(.background)
  }

  private var composer: some View {
    VStack(spacing: 12) {
      NoteEditor(
        text: Binding(
          get: { model.draft.text },
          set: {
            model.draft.text = $0
            model.persistDraft()
          }), editable: !model.saving, submit: model.save, dismiss: dismiss,
        files: model.addFiles, image: model.addImage
      )
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityLabel("Note text")
      if !model.draft.attachments.isEmpty {
        ScrollView {
          VStack(spacing: 6) {
            ForEach(model.draft.attachments) { attachment in
              HStack(spacing: 10) {
                Image(nsImage: NSWorkspace.shared.icon(forFile: attachment.localURL.path))
                  .resizable().scaledToFit().frame(width: 28, height: 28)
                Text(attachment.fileName).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
                if attachment.attached {
                  Image(systemName: "checkmark").foregroundStyle(.secondary).accessibilityLabel(
                    "Uploaded")
                } else {
                  Button {
                    model.removeAttachment(attachment.id)
                  } label: {
                    Image(systemName: "xmark.circle.fill")
                  }
                  .buttonStyle(.plain).foregroundStyle(.secondary)
                  .help("Remove \(attachment.fileName)").accessibilityLabel(
                    "Remove \(attachment.fileName)"
                  )
                  .disabled(model.saving)
                }
              }.padding(8).background(
                .quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
            }
          }
        }.frame(maxHeight: 112)
      }
      if let error = model.error {
        Text(error).font(.callout).foregroundStyle(.red).frame(
          maxWidth: .infinity, alignment: .leading
        ).textSelection(.enabled)
      }
      HStack(spacing: 12) {
        Button(action: model.chooseFiles) { Image(systemName: "paperclip") }
          .help("Attach files").accessibilityLabel("Attach files")
        if !model.draft.isEmpty {
          Button(action: model.discard) { Image(systemName: "trash") }
            .help("Discard draft").accessibilityLabel("Discard draft")
        }
        Spacer()
        if model.saved { Label("Saved", systemImage: "checkmark").foregroundStyle(.green) }
        if model.saving { ProgressView().controlSize(.small) }
        Button(action: model.save) { Text(model.saving ? "Saving…" : "Save").frame(minWidth: 64) }
          .buttonStyle(.borderedProminent).controlSize(.large)
          .help("Save (⌘Return)")
          .disabled(model.saving || model.draft.isEmpty)
      }.disabled(model.saving)
    }.padding(16)
  }

  private var recent: some View {
    Group {
      if model.history.isEmpty {
        VStack(spacing: 12) {
          Image(systemName: "clock").font(.system(size: 30)).foregroundStyle(.secondary)
          Text("No saved notes").foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ScrollView {
          LazyVStack(spacing: 0) {
            ForEach(model.history) { capture in
              Button {
                NSWorkspace.shared.open(capture.server.bookmarkURL(capture.id))
              } label: {
                VStack(alignment: .leading, spacing: 7) {
                  HStack(alignment: .firstTextBaseline) {
                    Text(capture.title).font(.headline).lineLimit(1)
                    Spacer()
                    Text(
                      capture.savedAt, format: .dateTime.month(.abbreviated).day().hour().minute()
                    )
                    .font(.caption).foregroundStyle(.secondary)
                  }
                  if capture.text != capture.title {
                    Text(capture.text).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                  }
                  ForEach(Array(capture.files.enumerated()), id: \.offset) { _, file in
                    Label(file, systemImage: "paperclip").font(.callout).foregroundStyle(.secondary)
                      .lineLimit(1)
                  }
                }.padding(16).frame(maxWidth: .infinity, alignment: .leading).contentShape(
                  Rectangle())
              }.buttonStyle(.plain).help("Open in Karakeep")
              Divider()
            }
          }
        }
      }
    }
  }
}

struct SettingsView: View {
  @ObservedObject var model: AppModel
  @State private var address = ""
  @State private var apiKey = ""

  var body: some View {
    Form {
      Section {
        LabeledContent("Server URL") {
          SettingsTextField(
            text: $address, placeholder: "https://karakeep.example.com",
            label: "Server URL", identifier: "serverURL"
          ).frame(maxWidth: .infinity)
        }
        LabeledContent("API key") {
          SettingsTextField(text: $apiKey, secure: true, label: "API key", identifier: "apiKey")
            .frame(maxWidth: .infinity)
        }
        HStack {
          Button(model.settings.user == nil ? "Connect" : "Reconnect") {
            model.connect(address: address, key: apiKey)
          }.buttonStyle(.borderedProminent)
          if model.connecting { ProgressView().controlSize(.small) }
          Spacer()
          if model.settings.user != nil { Button("Disconnect", action: model.disconnect) }
        }
        if let user = model.settings.user {
          LabeledContent("Account", value: user.displayName)
          if let email = user.email, email != user.displayName {
            LabeledContent("Email", value: email)
          }
        }
        Button("API Keys in Karakeep") {
          do {
            NSWorkspace.shared.open(try ServerAddress(address).endpoint("settings/api-keys"))
          } catch { model.settingsError = error.localizedDescription }
        }.buttonStyle(.link)
      }
      Section {
        LabeledContent("Screenshots folder") {
          HStack {
            Text(URL(fileURLWithPath: model.settings.screenshotFolder).lastPathComponent)
              .lineLimit(1).truncationMode(.middle).help(model.settings.screenshotFolder)
            Button("Choose…", action: model.chooseScreenshotFolder)
          }
        }
        Toggle("Launch at login", isOn: $model.launchAtLogin)
          .toggleStyle(.switch)
          .accessibilityIdentifier("launchAtLogin")
        if model.loginItemStatus == .requiresApproval {
          Button("Allow in System Settings…") { SMAppService.openSystemSettingsLoginItems() }
        }
        if let error = model.loginItemError {
          Text(error).foregroundStyle(.red).textSelection(.enabled)
        }
      }
      if let error = model.settingsError {
        Text(error).foregroundStyle(.red).textSelection(.enabled)
      }
    }
    .formStyle(.grouped).padding(8).frame(width: 500, height: 410)
    .disabled(model.connecting || model.saving)
    .onAppear {
      address = model.settings.server?.key ?? ""
      model.refreshLoginItemStatus()
    }
    .onChange(of: model.settings.server) { _, server in
      address = server?.key ?? ""
      apiKey = ""
    }
    .onChange(of: model.connecting) { _, connecting in
      if !connecting && model.settingsError == nil { apiKey = "" }
    }
  }
}

struct SettingsTextField: NSViewRepresentable {
  @Binding var text: String
  var secure = false
  var placeholder: String?
  let label: String
  let identifier: String

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeNSView(context: Context) -> NSTextField {
    let field = secure ? NSSecureTextField() : NSTextField()
    field.bezelStyle = .roundedBezel
    field.isBezeled = true
    field.isEditable = true
    field.isSelectable = true
    field.font = .systemFont(ofSize: NSFont.systemFontSize)
    field.alignment = .left
    field.placeholderString = placeholder
    field.maximumNumberOfLines = 1
    field.cell?.isScrollable = true
    field.setContentHuggingPriority(.defaultLow, for: .horizontal)
    field.setAccessibilityLabel(label)
    field.setAccessibilityIdentifier(identifier)
    field.delegate = context.coordinator
    return field
  }

  func updateNSView(_ field: NSTextField, context: Context) {
    context.coordinator.parent = self
    if field.stringValue != text { field.stringValue = text }
    field.alignment = .left
    field.currentEditor()?.alignment = .left
    field.isEnabled = context.environment.isEnabled
  }

  @MainActor final class Coordinator: NSObject, NSTextFieldDelegate {
    var parent: SettingsTextField
    init(_ parent: SettingsTextField) { self.parent = parent }
    func controlTextDidChange(_ notification: Notification) {
      if let field = notification.object as? NSTextField { parent.text = field.stringValue }
    }
  }
}

struct NoteEditor: NSViewRepresentable {
  @Binding var text: String
  let editable: Bool
  let submit: () -> Void
  let dismiss: () -> Void
  let files: ([URL]) -> Void
  let image: (Data) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeNSView(context: Context) -> NSScrollView {
    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    let editor = CaptureTextView()
    editor.isRichText = false
    editor.allowsUndo = true
    editor.isAutomaticQuoteSubstitutionEnabled = false
    editor.isAutomaticDashSubstitutionEnabled = false
    editor.isAutomaticTextReplacementEnabled = false
    editor.font = .systemFont(ofSize: 15)
    editor.textContainerInset = NSSize(width: 2, height: 8)
    editor.isVerticallyResizable = true
    editor.isHorizontallyResizable = false
    editor.autoresizingMask = [.width]
    editor.textContainer?.widthTracksTextView = true
    editor.drawsBackground = false
    editor.registerForDraggedTypes([.fileURL, .png, .tiff, .string])
    editor.delegate = context.coordinator
    editor.setAccessibilityLabel("Note text")
    editor.setAccessibilityIdentifier("noteEditor")
    scroll.documentView = editor
    configure(editor)
    return scroll
  }
  func updateNSView(_ scroll: NSScrollView, context: Context) {
    context.coordinator.parent = self
    guard let editor = scroll.documentView as? CaptureTextView else { return }
    if editor.string != text { editor.string = text }
    configure(editor)
  }
  private func configure(_ editor: CaptureTextView) {
    editor.isEditable = editable
    editor.submit = submit
    editor.dismiss = dismiss
    editor.files = files
    editor.image = image
  }
  @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
    var parent: NoteEditor
    init(_ parent: NoteEditor) { self.parent = parent }
    func textDidChange(_ notification: Notification) {
      if let editor = notification.object as? NSTextView { parent.text = editor.string }
    }
  }
}

final class CaptureTextView: NSTextView {
  var submit: (() -> Void)?
  var dismiss: (() -> Void)?
  var files: (([URL]) -> Void)?
  var image: ((Data) -> Void)?
  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    if event.keyCode == 36 || event.keyCode == 76, event.modifierFlags.contains(.command),
      !hasMarkedText()
    {
      if isEditable { submit?() }
      return true
    }
    return super.performKeyEquivalent(with: event)
  }
  override func keyDown(with event: NSEvent) {
    if event.keyCode == 36 || event.keyCode == 76, event.modifierFlags.contains(.command),
      !hasMarkedText()
    {
      if isEditable { submit?() }
    } else if event.keyCode == 53, !hasMarkedText() {
      dismiss?()
    } else {
      super.keyDown(with: event)
    }
  }
  override func paste(_ sender: Any?) {
    guard isEditable else { return }
    if acceptAttachments(from: .general) { return }
    super.paste(sender)
  }
  override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
    guard isEditable else { return false }
    if acceptAttachments(from: sender.draggingPasteboard) { return true }
    return super.performDragOperation(sender)
  }
  private func acceptAttachments(from pasteboard: NSPasteboard) -> Bool {
    let urls =
      pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
      as? [URL] ?? []
    if !urls.isEmpty {
      files?(urls)
      return true
    }
    if let data = pasteboard.data(forType: .png) {
      image?(data)
      return true
    }
    if let data = pasteboard.data(forType: .tiff), let bitmap = NSBitmapImageRep(data: data),
      let png = bitmap.representation(using: .png, properties: [:])
    {
      image?(png)
      return true
    }
    return false
  }
}
