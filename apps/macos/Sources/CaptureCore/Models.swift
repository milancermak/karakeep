import Foundation

public struct ServerAddress: Codable, Hashable, Sendable {
  public let url: URL
  public init(_ value: String) throws {
    guard var parts = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
      let scheme = parts.scheme?.lowercased(), let host = parts.host, !host.isEmpty,
      parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
      scheme == "https"
        || (scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host))
    else { throw CaptureError.message("Enter an HTTPS server URL, or HTTP for localhost.") }
    parts.scheme = scheme
    parts.host = host.lowercased()
    var path = parts.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    if path == "api/v1" {
      path = ""
    } else if path.hasSuffix("/api/v1") {
      path = String(path.dropLast(7))
    }
    parts.path = path.isEmpty ? "" : "/" + path
    guard let url = parts.url else { throw CaptureError.message("Invalid server URL.") }
    self.url = url
  }
  public var key: String { url.absoluteString }
  public func endpoint(_ path: String) -> URL { url.appendingPathComponent(path) }
  public func bookmarkURL(_ id: String) -> URL {
    endpoint("dashboard/preview").appendingPathComponent(id)
  }
}

public struct User: Codable, Equatable, Sendable {
  public let id: String
  public let name: String?
  public let email: String?
  public init(id: String, name: String?, email: String?) {
    self.id = id
    self.name = name
    self.email = email
  }
  public var displayName: String { name.flatMap { $0.isEmpty ? nil : $0 } ?? email ?? "Connected" }
}

public struct Settings: Codable, Sendable {
  public var server: ServerAddress?
  public var user: User?
  public var screenshotFolder: String
  public init() {
    let configured = UserDefaults(suiteName: "com.apple.screencapture")?.string(forKey: "location")
    screenshotFolder =
      (configured as NSString?)?.expandingTildeInPath
      ?? FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask).first!.path
  }
  public var accountKey: String? {
    guard let server, let user else { return nil }
    return server.key + "#" + user.id
  }
}

public struct Attachment: Codable, Identifiable, Equatable, Sendable {
  public var id: UUID
  public var fileName: String
  public var localURL: URL
  public var uploadedID: String?
  public var attached: Bool = false
  public init(fileName: String, localURL: URL) {
    id = UUID()
    self.fileName = fileName
    self.localURL = localURL
  }
  public var mimeType: String {
    let types = [
      "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
      "webp": "image/webp", "pdf": "application/pdf", "html": "text/html", "htm": "text/html",
      "mp4": "video/mp4", "webm": "video/webm", "mkv": "video/x-matroska",
    ]
    return types[localURL.pathExtension.lowercased()] ?? "application/octet-stream"
  }
}

public struct Draft: Codable, Sendable {
  public var text = ""
  public var attachments: [Attachment] = []
  public var accountKey: String?
  public var bookmarkID: String?
  public var createdAt: Date?
  public init() {}
  public var isEmpty: Bool {
    text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty
  }
  public var serverText: String {
    text.isEmpty ? attachments.map(\.fileName).joined(separator: "\n") : text
  }
}

public struct SavedCapture: Codable, Identifiable, Sendable {
  public var id: String
  public var accountKey: String
  public var server: ServerAddress
  public var text: String
  public var files: [String]
  public var savedAt: Date
  public var title: String {
    text.split(whereSeparator: \.isNewline).first.map(String.init) ?? files.first ?? "Note"
  }
}

public enum CaptureError: LocalizedError, Sendable {
  case message(String)
  public var errorDescription: String? { if case .message(let text) = self { text } else { nil } }
}

public enum Screenshots {
  public static func latest(in folder: URL) throws -> URL {
    let keys: Set<URLResourceKey> = [
      .isRegularFileKey, .creationDateKey, .contentModificationDateKey,
    ]
    let files = try FileManager.default.contentsOfDirectory(
      at: folder, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles])
    let images = try files.compactMap { url -> (URL, Date)? in
      let values = try url.resourceValues(forKeys: keys)
      guard values.isRegularFile == true,
        ["png", "jpg", "jpeg", "heic", "heif", "tiff", "tif", "gif", "webp", "bmp", "pdf"].contains(
          url.pathExtension.lowercased())
      else { return nil }
      return (url, values.creationDate ?? values.contentModificationDate ?? .distantPast)
    }
    guard
      let latest = images.sorted(by: {
        $0.1 == $1.1 ? $0.0.lastPathComponent > $1.0.lastPathComponent : $0.1 > $1.1
      }).first
    else {
      throw CaptureError.message("No screenshots found in the selected folder.")
    }
    return latest.0
  }
}
