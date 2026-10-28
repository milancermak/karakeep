import Foundation
import Security

public struct CaptureStore: Sendable {
  public let root: URL
  public init(root: URL? = nil) throws {
    self.root =
      root
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
      .appendingPathComponent("Karakeep Capture", isDirectory: true)
    try FileManager.default.createDirectory(
      at: self.root.appendingPathComponent("Attachments"), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: self.root.path)
  }
  public func read<T: Decodable>(_ name: String, default fallback: T) throws -> T {
    let url = root.appendingPathComponent(name + ".json")
    guard FileManager.default.fileExists(atPath: url.path) else { return fallback }
    return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
  }
  public func write<T: Encodable>(_ value: T, to name: String) throws {
    let data = try JSONEncoder().encode(value)
    let url = root.appendingPathComponent(name + ".json")
    try data.write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }
  public func stage(_ source: URL) throws -> Attachment {
    let values = try source.resourceValues(forKeys: [.isRegularFileKey])
    guard source.isFileURL, values.isRegularFile == true else {
      throw CaptureError.message("Choose files rather than folders.")
    }
    let directory = root.appendingPathComponent("Attachments").appendingPathComponent(
      UUID().uuidString)
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let target = directory.appendingPathComponent(source.lastPathComponent)
    do {
      try FileManager.default.copyItem(at: source, to: target)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
    return Attachment(fileName: source.lastPathComponent, localURL: target)
  }
  public func removeStaged(_ attachment: Attachment) {
    let directory = attachment.localURL.deletingLastPathComponent().standardizedFileURL
    guard
      directory.deletingLastPathComponent()
        == root.appendingPathComponent("Attachments").standardizedFileURL
    else { return }
    try? FileManager.default.removeItem(at: directory)
  }
  public func history(for account: String) throws -> [SavedCapture] {
    let all: [SavedCapture] = try read("history", default: [])
    return all.filter { $0.accountKey == account }.sorted { $0.savedAt > $1.savedAt }
  }
  public func complete(_ capture: SavedCapture, draft: Draft) throws {
    var all: [SavedCapture] = try read("history", default: [])
    all.removeAll { $0.id == capture.id && $0.accountKey == capture.accountKey }
    all.append(capture)
    try write(all, to: "history")
    try write(Draft(), to: "draft")
    draft.attachments.forEach(removeStaged)
  }
}

public enum Credentials {
  private static let service = "app.karakeep.capture.api-key"
  public static func read(server: ServerAddress) throws -> String? {
    var query = identity(server)
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = item as? Data,
      let value = String(data: data, encoding: .utf8)
    else { throw failure(status) }
    return value
  }
  public static func save(_ key: String, server: ServerAddress) throws {
    let query = identity(server)
    let data = Data(key.utf8)
    let status = SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary)
    if status == errSecItemNotFound {
      var item = query
      item[kSecValueData] = data
      item[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      let added = SecItemAdd(item as CFDictionary, nil)
      guard added == errSecSuccess else { throw failure(added) }
    } else if status != errSecSuccess {
      throw failure(status)
    }
  }
  public static func delete(server: ServerAddress) throws {
    let status = SecItemDelete(identity(server) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw failure(status) }
  }
  private static func identity(_ server: ServerAddress) -> [CFString: Any] {
    [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: server.key]
  }
  private static func failure(_ status: OSStatus) -> CaptureError {
    .message("Keychain could not be accessed (\(status)).")
  }
}
