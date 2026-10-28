import Foundation

public struct RemoteBookmark: Decodable, Sendable {
  public let id: String
  public let createdAt: String
}

public struct UploadedAsset: Decodable, Sendable {
  public let assetId: String
  public let contentType: String
  public let fileName: String
  public let size: Int
}

public protocol CaptureAPI: Sendable {
  func currentUser() async throws -> User
  func create(text: String) async throws -> RemoteBookmark
  func update(id: String, text: String) async throws
  func upload(_ attachment: Attachment) async throws -> UploadedAsset
  func attach(assetID: String, bookmarkID: String) async throws
}

public final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
  public func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

public actor APIClient: CaptureAPI {
  public let server: ServerAddress
  private let apiKey: String
  private let session: URLSession
  public init(server: ServerAddress, apiKey: String, session: URLSession? = nil) {
    self.server = server
    self.apiKey = apiKey
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 60
    config.timeoutIntervalForResource = 600
    config.httpShouldSetCookies = false
    self.session =
      session ?? URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
  }
  public func currentUser() async throws -> User {
    try JSONDecoder().decode(User.self, from: await request("users/me"))
  }
  public func create(text: String) async throws -> RemoteBookmark {
    try JSONDecoder().decode(
      RemoteBookmark.self,
      from: await request(
        "bookmarks", method: "POST", json: ["type": "text", "text": text, "source": "api"]))
  }
  public func update(id: String, text: String) async throws {
    _ = try await request("bookmarks/\(id)", method: "PATCH", json: ["text": text])
  }
  public func attach(assetID: String, bookmarkID: String) async throws {
    _ = try await request(
      "bookmarks/\(bookmarkID)/assets", method: "POST",
      json: ["id": assetID, "assetType": "userUploaded"])
  }
  public func upload(_ attachment: Attachment) async throws -> UploadedAsset {
    let boundary = "Karakeep-" + UUID().uuidString
    let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    FileManager.default.createFile(
      atPath: temp.path, contents: nil, attributes: [.posixPermissions: 0o600])
    defer { try? FileManager.default.removeItem(at: temp) }
    let output = try FileHandle(forWritingTo: temp)
    defer { try? output.close() }
    let escapedName = attachment.fileName.replacingOccurrences(of: "\\", with: "_")
      .replacingOccurrences(of: "\"", with: "_")
      .replacingOccurrences(of: "\r", with: "_").replacingOccurrences(of: "\n", with: "_")
    try output.write(
      contentsOf: Data(
        "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(escapedName)\"\r\nContent-Type: \(attachment.mimeType)\r\n\r\n"
          .utf8))
    let input = try FileHandle(forReadingFrom: attachment.localURL)
    defer { try? input.close() }
    while let chunk = try input.read(upToCount: 1_048_576), !chunk.isEmpty {
      try Task.checkCancellation()
      try output.write(contentsOf: chunk)
    }
    try output.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
    try output.synchronize()
    var req = makeRequest("assets", method: "POST")
    req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    let (data, response) = try await session.upload(for: req, fromFile: temp)
    try validate(response)
    return try JSONDecoder().decode(UploadedAsset.self, from: data)
  }
  private func makeRequest(_ path: String, method: String) -> URLRequest {
    var req = URLRequest(url: server.endpoint("api/v1/" + path))
    req.httpMethod = method
    req.setValue("Bearer " + apiKey, forHTTPHeaderField: "Authorization")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    return req
  }
  private func request(_ path: String, method: String = "GET", json: [String: String]? = nil)
    async throws -> Data
  {
    var req = makeRequest(path, method: method)
    if let json {
      req.httpBody = try JSONEncoder().encode(json)
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await session.data(for: req)
    try validate(response)
    return data
  }
  private func validate(_ response: URLResponse) throws {
    guard let http = response as? HTTPURLResponse else {
      throw CaptureError.message("The server returned an invalid response.")
    }
    guard (200..<300).contains(http.statusCode) else {
      let message: String
      switch http.statusCode {
      case 300..<400: message = "The server redirected this request. Use its final URL in Settings."
      case 401: message = "Your API key was rejected. Reconnect in Settings."
      case 403: message = "The server denied access. Check API key permissions and storage quota."
      case 413: message = "This file exceeds the server’s upload limit."
      case 429: message = "The server is busy. Wait a moment before saving again."
      case 400, 415, 422:
        message =
          "The server rejected this note or file type. General files need this fork’s server update."
      default: message = "The server could not complete the request (\(http.statusCode))."
      }
      throw CaptureError.message(message)
    }
  }
}

public actor CaptureService {
  private let api: any CaptureAPI
  private let store: CaptureStore
  public init(api: any CaptureAPI, store: CaptureStore) {
    self.api = api
    self.store = store
  }
  public func save(_ initial: Draft, server: ServerAddress, user: User) async throws -> SavedCapture
  {
    var draft = initial
    let account = server.key + "#" + user.id
    guard !draft.isEmpty else { throw CaptureError.message("Add text or a file first.") }
    guard draft.accountKey == nil || draft.accountKey == account else {
      throw CaptureError.message(
        "Finish this draft with its original account, or discard it first.")
    }
    draft.accountKey = account
    try store.write(draft, to: "draft")
    if let id = draft.bookmarkID {
      try await api.update(id: id, text: draft.serverText)
    } else {
      let bookmark = try await api.create(text: draft.serverText)
      draft.bookmarkID = bookmark.id
      draft.createdAt = ISO8601DateFormatter().date(from: bookmark.createdAt) ?? Date()
      try store.write(draft, to: "draft")
    }
    let id = draft.bookmarkID!
    for index in draft.attachments.indices {
      if draft.attachments[index].attached { continue }
      if draft.attachments[index].uploadedID == nil {
        let uploaded = try await api.upload(draft.attachments[index])
        draft.attachments[index].uploadedID = uploaded.assetId
        try store.write(draft, to: "draft")
      }
      try await api.attach(assetID: draft.attachments[index].uploadedID!, bookmarkID: id)
      draft.attachments[index].attached = true
      try store.write(draft, to: "draft")
    }
    let capture = SavedCapture(
      id: id, accountKey: account, server: server, text: draft.text,
      files: draft.attachments.map(\.fileName), savedAt: Date())
    try store.complete(capture, draft: draft)
    return capture
  }
}
