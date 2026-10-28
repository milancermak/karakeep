import AppKit
import SwiftUI
import Testing

@testable import KarakeepMenuBar

@MainActor
struct SettingsFieldTests {
  @Test(arguments: [false, true])
  func groupedFormFieldsAndInsertionPointsAreLeftAligned(dark: Bool) throws {
    _ = NSApplication.shared
    let form = Form {
      Section {
        LabeledContent("Server URL") {
          SettingsTextField(
            text: .constant("https://capture.example.com"), label: "Server URL",
            identifier: "serverURL"
          ).frame(maxWidth: .infinity)
        }
        LabeledContent("API key") {
          SettingsTextField(
            text: .constant("test-only-key"), secure: true, label: "API key", identifier: "apiKey"
          ).frame(maxWidth: .infinity)
        }
      }
    }.formStyle(.grouped).frame(width: 500, height: 180)
      .preferredColorScheme(dark ? .dark : .light)
    let host = NSHostingView(rootView: form)
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 500, height: 180),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    window.contentView = host
    host.layoutSubtreeIfNeeded()
    defer { window.orderOut(nil) }

    func descendants(_ view: NSView) -> [NSView] {
      [view] + view.subviews.flatMap(descendants)
    }
    let fields = descendants(host).compactMap { $0 as? NSTextField }
    for id in ["serverURL", "apiKey"] {
      let field = try #require(fields.first { $0.accessibilityIdentifier() == id })
      #expect(field.alignment == .left)
      #expect(field is NSSecureTextField == (id == "apiKey"))
      field.selectText(nil)
      let editor = try #require(field.currentEditor() as? NSTextView)
      #expect(editor.alignment == .left)
      editor.setSelectedRange(NSRange(location: 0, length: 0))
      let caret = editor.firstRect(
        forCharacterRange: NSRange(location: 0, length: 0), actualRange: nil)
      let bounds = window.convertToScreen(field.convert(field.bounds, to: nil))
      #expect(caret.minX - bounds.minX >= 0)
      #expect(caret.minX - bounds.minX < 20)
    }
    window.makeFirstResponder(nil)
  }
}
