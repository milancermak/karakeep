import Foundation
import Testing

@testable import CaptureCore

struct LiveServerTests {
  @Test(.enabled(if: ProcessInfo.processInfo.environment["KARAKEEP_CAPTURE_TEST_SERVER"] != nil))
  func roundTripWithLocalKarakeep() async throws {
    let env = ProcessInfo.processInfo.environment
    let server = try ServerAddress(#require(env["KARAKEEP_CAPTURE_TEST_SERVER"]))
    #expect(["localhost", "127.0.0.1"].contains(server.url.host ?? ""))
    guard ["localhost", "127.0.0.1"].contains(server.url.host ?? "") else { return }
    let key = try String(
      contentsOfFile: #require(env["KARAKEEP_CAPTURE_TEST_KEY_FILE"]), encoding: .utf8
    ).trimmingCharacters(in: .whitespacesAndNewlines)
    let api = APIClient(server: server, apiKey: key)
    let user = try await api.currentUser()
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "capture-live-" + UUID().uuidString)
    let store = try CaptureStore(root: root)
    defer { try? FileManager.default.removeItem(at: root) }
    var draft = Draft()
    draft.text = "macOS capture integration\nEnter and Shift+Enter\nUnicode: café 日本語"
    let png = Data(
      base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/1sAAAAASUVORK5CYII="
    )!
    let files: [(String, Data)] = [
      ("capture.png", png), ("notes.txt", Data("A generic file\nwith exact bytes".utf8)),
    ]
    for (name, bytes) in files {
      let url = root.appendingPathComponent(name)
      try bytes.write(to: url)
      draft.attachments.append(try store.stage(url))
    }
    let capture = try await CaptureService(api: api, store: store).save(
      draft, server: server, user: user)
    func request(_ path: String, method: String = "GET") async throws -> (Data, HTTPURLResponse) {
      var req = URLRequest(url: server.endpoint("api/v1/" + path))
      req.httpMethod = method
      req.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
      let (data, response) = try await URLSession.shared.data(for: req)
      return (data, try #require(response as? HTTPURLResponse))
    }
    do {
      let (body, response) = try await request("bookmarks/" + capture.id)
      #expect(response.statusCode == 200)
      let bookmark = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
      let content = try #require(bookmark["content"] as? [String: Any])
      #expect(content["text"] as? String == draft.text)
      let assets = try #require(bookmark["assets"] as? [[String: Any]])
      #expect(assets.count == 2)
      for (name, bytes) in files {
        let asset = try #require(assets.first { $0["fileName"] as? String == name })
        #expect(asset["assetType"] as? String == "userUploaded")
        let (downloaded, downloadResponse) = try await request(
          "assets/" + #require(asset["id"] as? String))
        #expect(downloaded == bytes)
        if name.hasSuffix(".txt") {
          #expect(
            downloadResponse.value(forHTTPHeaderField: "Content-Disposition")?.hasPrefix(
              "attachment;") == true)
        }
      }
      if let evidence = env["KARAKEEP_CAPTURE_TEST_EVIDENCE"] {
        try body.write(to: URL(fileURLWithPath: evidence))
      }
      #expect(try store.history(for: capture.accountKey).first?.id == capture.id)
      _ = try await request("bookmarks/" + capture.id, method: "DELETE")
    } catch {
      _ = try? await request("bookmarks/" + capture.id, method: "DELETE")
      throw error
    }
  }
}
