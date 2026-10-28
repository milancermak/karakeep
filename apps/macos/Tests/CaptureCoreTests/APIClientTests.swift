import Foundation
import Testing

@testable import CaptureCore

@Suite(.serialized)
struct APIClientTests {
  private func client() throws -> APIClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MockURLProtocol.self]
    return APIClient(
      server: try ServerAddress("https://capture.example.com/base"), apiKey: "test-only-key",
      session: URLSession(configuration: config))
  }

  @Test func authenticatesAndPreservesTextAndBasePath() async throws {
    MockURLProtocol.state.set { request in
      #expect(request.url?.absoluteString == "https://capture.example.com/base/api/v1/bookmarks")
      #expect(request.httpMethod == "POST")
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-only-key")
      #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
      var body = request.httpBody ?? Data()
      if let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
          let count = stream.read(&buffer, maxLength: buffer.count)
          if count <= 0 { break }
          body.append(contentsOf: buffer.prefix(count))
        }
      }
      let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
      #expect(json == ["type": "text", "text": "first\nsecond\n日本語", "source": "api"])
      return (201, Data(#"{"id":"capture-1","createdAt":"2026-10-27T12:00:00.000Z"}"#.utf8))
    }
    let result = try await client().create(text: "first\nsecond\n日本語")
    #expect(result.id == "capture-1")
  }

  @Test func acceptsNullableAccountFields() async throws {
    MockURLProtocol.state.set { request in
      #expect(request.url?.path == "/base/api/v1/users/me")
      return (200, Data(#"{"id":"user-1","name":null,"email":null,"localUser":true}"#.utf8))
    }
    let user = try await client().currentUser()
    #expect(user.id == "user-1")
    #expect(user.displayName == "Connected")
  }

  @Test(arguments: [400, 401, 403, 413, 429, 500])
  func reportsHTTPFailuresWithoutReflectingServerSecrets(status: Int) async throws {
    MockURLProtocol.state.set { _ in (status, Data(#"{"error":"do-not-reflect-this-secret"}"#.utf8))
    }
    do {
      _ = try await client().currentUser()
      Issue.record("HTTP failure was accepted")
    } catch {
      #expect(!error.localizedDescription.contains("do-not-reflect-this-secret"))
      #expect(error is CaptureError)
    }
  }

  @Test func rejectsMalformedSuccessBody() async throws {
    MockURLProtocol.state.set { _ in (200, Data("<html>Not an API</html>".utf8)) }
    await #expect(throws: (any Error).self) { try await client().currentUser() }
  }
}

private final class MockURLProtocol: URLProtocol, @unchecked Sendable {
  static let state = MockResponses()
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      let (status, bytes) = try Self.state.respond(request)
      let response = HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: bytes)
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}

private final class MockResponses: @unchecked Sendable {
  private let lock = NSLock()
  private var handler: (@Sendable (URLRequest) throws -> (Int, Data))?
  func set(_ handler: @escaping @Sendable (URLRequest) throws -> (Int, Data)) {
    lock.withLock { self.handler = handler }
  }
  func respond(_ request: URLRequest) throws -> (Int, Data) {
    let handler = lock.withLock { self.handler }
    return try handler!(request)
  }
}
