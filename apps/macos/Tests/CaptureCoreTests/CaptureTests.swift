import AppKit
import Foundation
import Testing

@testable import CaptureCore
@testable import KarakeepMenuBar

@Suite(.serialized)
struct CaptureTests {
  let user = User(id: "test-user", name: "Capture Test", email: nil)
  let server = try! ServerAddress("http://localhost:3199")

  @Test func validatesServerURLs() throws {
    #expect(
      try ServerAddress(" https://example.com/karakeep/api/v1/ ").key
        == "https://example.com/karakeep")
    #expect(throws: (any Error).self) { try ServerAddress("http://example.com") }
    #expect(throws: (any Error).self) { try ServerAddress("https://user:secret@example.com") }
    #expect(throws: (any Error).self) { try ServerAddress("https://example.com?token=secret") }
    #expect(throws: (any Error).self) { try ServerAddress("file:///tmp/server") }
    #expect(
      try ServerAddress("http://localhost:3100/").endpoint("api/v1/users/me").absoluteString
        == "http://localhost:3100/api/v1/users/me")
  }

  @Test func stagesCopiesAndRestoresDraft() throws {
    let store = try temporaryStore()
    defer { try? FileManager.default.removeItem(at: store.root) }
    let source = store.root.appendingPathComponent("original.txt")
    try Data("first version".utf8).write(to: source)
    var draft = Draft()
    draft.text = "A note\nwith newlines"
    draft.attachments = [try store.stage(source)]
    try store.write(draft, to: "draft")
    try Data("changed".utf8).write(to: source)
    let recovered: Draft = try store.read("draft", default: Draft())
    #expect(recovered.text == draft.text)
    #expect(
      try String(contentsOf: recovered.attachments[0].localURL, encoding: .utf8) == "first version")
    #expect(recovered.attachments[0].mimeType == "application/octet-stream")
    #expect(throws: (any Error).self) { try store.stage(store.root) }
  }

  @Test func savesOneNoteWithSeveralFilesAndKeepsAccountHistory() async throws {
    let store = try temporaryStore()
    defer { try? FileManager.default.removeItem(at: store.root) }
    var draft = Draft()
    draft.text = "one\ntwo\nthree"
    for file in ["a.txt", "b.pdf"] {
      let url = store.root.appendingPathComponent(file)
      try Data("attachment".utf8).write(to: url)
      draft.attachments.append(try store.stage(url))
    }
    let api = FakeAPI()
    let saved = try await CaptureService(api: api, store: store).save(
      draft, server: server, user: user)
    #expect(await api.createCount == 1)
    #expect(await api.uploadCount == 2)
    #expect(await api.attachCount == 2)
    #expect(saved.text == draft.text)
    #expect(try store.history(for: saved.accountKey).count == 1)
    #expect(try store.history(for: "another-account").isEmpty)
    let recovered: Draft = try store.read("draft", default: Draft())
    #expect(recovered.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: draft.attachments[0].localURL.path))
  }

  @Test func resumesPartialSaveWithoutRecreatingNoteOrReuploading() async throws {
    let store = try temporaryStore()
    defer { try? FileManager.default.removeItem(at: store.root) }
    let url = store.root.appendingPathComponent("attachment.txt")
    try Data("file".utf8).write(to: url)
    var draft = Draft()
    draft.text = "Keep this note"
    draft.attachments = [try store.stage(url)]
    let api = FakeAPI(failAttachment: true)
    let service = CaptureService(api: api, store: store)
    await #expect(throws: (any Error).self) {
      try await service.save(draft, server: server, user: user)
    }
    var recovered: Draft = try store.read("draft", default: Draft())
    #expect(recovered.bookmarkID == "bookmark-1")
    #expect(recovered.attachments[0].uploadedID == "asset-1")
    #expect(recovered.attachments[0].attached == false)
    recovered.text += "\nEdited after failure"
    await api.allowAttachments()
    _ = try await service.save(recovered, server: server, user: user)
    #expect(await api.createCount == 1)
    #expect(await api.uploadCount == 1)
    #expect(await api.updateCount == 1)
    #expect(await api.lastText == recovered.text)
  }

  @Test func rejectsCrossAccountDraftAndEmptySave() async throws {
    let store = try temporaryStore()
    defer { try? FileManager.default.removeItem(at: store.root) }
    let api = FakeAPI()
    let service = CaptureService(api: api, store: store)
    await #expect(throws: (any Error).self) {
      try await service.save(Draft(), server: server, user: user)
    }
    var draft = Draft()
    draft.text = "private"
    draft.accountKey = "other-account"
    await #expect(throws: (any Error).self) {
      try await service.save(draft, server: server, user: user)
    }
    #expect(await api.createCount == 0)
  }

  @Test func recentNotesAreNewestFirstAndIdempotentOnLocalCompletion() throws {
    let store = try temporaryStore()
    defer { try? FileManager.default.removeItem(at: store.root) }
    let account = server.key + "#" + user.id
    let old = SavedCapture(
      id: "older", accountKey: account, server: server, text: "old", files: [],
      savedAt: Date(timeIntervalSince1970: 10))
    let new = SavedCapture(
      id: "newer", accountKey: account, server: server, text: "new", files: [],
      savedAt: Date(timeIntervalSince1970: 20))
    try store.complete(new, draft: Draft())
    try store.complete(old, draft: Draft())
    try store.complete(new, draft: Draft())
    #expect(try store.history(for: account).map(\.id) == ["newer", "older"])
  }

  @Test func latestScreenshotIgnoresFoldersAndNonImages() throws {
    let store = try temporaryStore()
    defer { try? FileManager.default.removeItem(at: store.root) }
    let folder = store.root.appendingPathComponent("screenshots")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    #expect(throws: (any Error).self) { try Screenshots.latest(in: folder) }
    for (name, timestamp) in [("old.png", 10.0), ("recent.jpeg", 20.0), ("newest.txt", 30.0)] {
      let url = folder.appendingPathComponent(name)
      try Data().write(to: url)
      try FileManager.default.setAttributes(
        [.creationDate: Date(timeIntervalSince1970: timestamp)], ofItemAtPath: url.path)
    }
    try FileManager.default.createDirectory(
      at: folder.appendingPathComponent("folder.png"), withIntermediateDirectories: true)
    #expect(try Screenshots.latest(in: folder).lastPathComponent == "recent.jpeg")
  }

  @Test @MainActor func returnAndShiftReturnInsertNewlinesCommandReturnSubmits() throws {
    _ = NSApplication.shared
    let editor = CaptureTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 250))
    editor.isRichText = false
    var submits = 0
    editor.submit = { submits += 1 }
    func key(_ flags: NSEvent.ModifierFlags) -> NSEvent {
      NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
        windowNumber: 0, context: nil, characters: "\r", charactersIgnoringModifiers: "\r",
        isARepeat: false, keyCode: 36)!
    }
    editor.keyDown(with: key([]))
    editor.keyDown(with: key(.shift))
    #expect(editor.string == "\n\n")
    #expect(submits == 0)
    editor.keyDown(with: key(.command))
    #expect(submits == 1)
    #expect(editor.string == "\n\n")
    #expect(editor.performKeyEquivalent(with: key(.command)))
    #expect(submits == 2)
    editor.isEditable = false
    editor.keyDown(with: key(.command))
    #expect(editor.performKeyEquivalent(with: key(.command)))
    #expect(submits == 2)
  }

  private func temporaryStore() throws -> CaptureStore {
    try CaptureStore(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(
        "karakeep-test-" + UUID().uuidString))
  }
}

actor FakeAPI: CaptureAPI {
  var createCount = 0
  var uploadCount = 0
  var attachCount = 0
  var updateCount = 0
  var lastText = ""
  var failAttachment: Bool
  init(failAttachment: Bool = false) { self.failAttachment = failAttachment }
  func allowAttachments() { failAttachment = false }
  func currentUser() async throws -> User { User(id: "test-user", name: nil, email: nil) }
  func create(text: String) async throws -> RemoteBookmark {
    createCount += 1
    lastText = text
    return try JSONDecoder().decode(
      RemoteBookmark.self,
      from: Data(#"{"id":"bookmark-1","createdAt":"2026-10-27T10:00:00Z"}"#.utf8))
  }
  func update(id: String, text: String) async throws {
    updateCount += 1
    lastText = text
  }
  func upload(_ attachment: CaptureCore.Attachment) async throws -> UploadedAsset {
    uploadCount += 1
    return try JSONDecoder().decode(
      UploadedAsset.self,
      from: Data(
        "{\"assetId\":\"asset-\(uploadCount)\",\"contentType\":\"application/octet-stream\",\"fileName\":\"attachment.txt\",\"size\":4}"
          .utf8))
  }
  func attach(assetID: String, bookmarkID: String) async throws {
    attachCount += 1
    if failAttachment { throw CaptureError.message("Upload interrupted") }
  }
}
