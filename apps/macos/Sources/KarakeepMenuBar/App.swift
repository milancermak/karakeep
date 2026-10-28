import AppKit
import CaptureCore
import SwiftUI

@main
struct KarakeepCaptureApp {
  @MainActor static func main() {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.delegate = delegate
    application.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { application.run() }
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
  private var statusItem: NSStatusItem!
  private let popover = NSPopover()
  private var settingsWindow: NSWindow?
  private var model: AppModel!

  func applicationDidFinishLaunching(_ notification: Notification) {
    do {
      let directory = ProcessInfo.processInfo.environment["KARAKEEP_CAPTURE_DATA_DIR"].map {
        URL(fileURLWithPath: $0)
      }
      model = AppModel(store: try CaptureStore(root: directory))
    } catch {
      let alert = NSAlert()
      alert.messageText = "Karakeep Capture could not start"
      alert.informativeText = error.localizedDescription
      alert.runModal()
      NSApp.terminate(nil)
      return
    }
    model.presentSettings = { [weak self] in self?.showSettings() }
    installEditMenu()
    statusItem = NSStatusBar.system.statusItem(withLength: 28)
    if let button = statusItem.button {
      let icon = Bundle.main.url(forResource: "KarakeepStatus", withExtension: "pdf")
        .flatMap { NSImage(contentsOf: $0) }
      icon?.size = NSSize(width: 18, height: 18)
      icon?.isTemplate = true
      button.image = icon
      button.toolTip = "Karakeep Capture"
      let drop = StatusDropView(frame: button.bounds)
      drop.autoresizingMask = [.width, .height]
      drop.clicked = { [weak self] right in
        guard let self else { return }
        if right {
          self.showMenu()
        } else if self.popover.isShown {
          self.popover.performClose(nil)
        } else {
          self.showCapture()
        }
      }
      drop.receivedFiles = { [weak self] urls in
        guard let self, !self.model.saving else { return false }
        self.model.addFiles(urls)
        self.showCapture()
        return true
      }
      drop.canDrop = { [weak self] in self?.model.saving == false }
      button.addSubview(drop)
    }
    popover.behavior = .applicationDefined
    popover.delegate = self
    popover.contentViewController = NSHostingController(
      rootView: CaptureView(
        model: model, dismiss: { [weak self] in self?.popover.performClose(nil) }))
    NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) {
      [weak self] event in
      if let self, NSApp.modalWindow == nil, self.popover.isShown,
        event.window !== self.popover.contentViewController?.view.window,
        event.window !== self.statusItem.button?.window
      {
        self.popover.performClose(nil)
      }
      return event
    }
    NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) {
      [weak self] _ in
      if NSApp.modalWindow == nil { self?.popover.performClose(nil) }
    }
    model.configureLoginItem()
    if model.settings.server == nil || model.loginItemError != nil { showSettings() }
  }

  func applicationDidBecomeActive(_ notification: Notification) {
    model?.refreshLoginItemStatus()
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    showCapture()
    return true
  }

  @objc private func showCapture() {
    guard let button = statusItem.button else { return }
    model.showingHistory = false
    NSApp.activate(ignoringOtherApps: true)
    if !popover.isShown {
      popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    }
    popover.contentViewController?.view.window?.makeKey()
    focusEditor(in: popover.contentViewController?.view)
  }

  private func focusEditor(in view: NSView?) {
    guard let view else { return }
    if let editor = view as? CaptureTextView {
      editor.window?.makeFirstResponder(editor)
      return
    }
    for child in view.subviews { focusEditor(in: child) }
  }

  @objc private func showRecent() {
    showCapture()
    model.showingHistory = true
  }

  @objc private func uploadScreenshot() {
    model.latestScreenshot()
    showCapture()
  }

  @objc private func showSettings() {
    popover.performClose(nil)
    if settingsWindow == nil {
      let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 500, height: 410),
        styleMask: [.titled, .closable], backing: .buffered, defer: false)
      window.title = "Karakeep Settings"
      window.level = .floating
      window.isReleasedWhenClosed = false
      window.contentViewController = NSHostingController(rootView: SettingsView(model: model))
      window.center()
      settingsWindow = window
    }
    NSApp.activate(ignoringOtherApps: true)
    settingsWindow?.makeKeyAndOrderFront(nil)
  }

  private func showMenu() {
    popover.performClose(nil)
    let menu = NSMenu()
    for (title, action, key) in [
      ("New Note", #selector(showCapture), "n"),
      ("Recent Notes", #selector(showRecent), ""),
      ("Upload Last Screenshot", #selector(uploadScreenshot), ""),
    ] {
      let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
      item.target = self
      item.isEnabled = !model.saving
      menu.addItem(item)
    }
    menu.addItem(.separator())
    let settings = NSMenuItem(
      title: "Settings…", action: #selector(showSettings), keyEquivalent: ",")
    settings.target = self
    menu.addItem(settings)
    menu.addItem(.separator())
    let quit = NSMenuItem(title: "Quit Karakeep", action: #selector(quitApp), keyEquivalent: "q")
    quit.target = self
    menu.addItem(quit)
    statusItem.menu = menu
    statusItem.button?.performClick(nil)
    statusItem.menu = nil
  }

  @objc private func quitApp() {
    if model.saving {
      let alert = NSAlert()
      alert.messageText = "A note is still saving"
      alert.informativeText = "Wait for saving to finish before quitting."
      alert.runModal()
      return
    }
    NSApp.terminate(nil)
  }

  private func installEditMenu() {
    let menu = NSMenu()
    let appItem = NSMenuItem()
    let app = NSMenu()
    app.addItem(withTitle: "New Note", action: #selector(showCapture), keyEquivalent: "n").target =
      self
    app.addItem(withTitle: "Recent Notes", action: #selector(showRecent), keyEquivalent: "")
      .target = self
    app.addItem(.separator())
    app.addItem(withTitle: "Settings…", action: #selector(showSettings), keyEquivalent: ",")
      .target = self
    app.addItem(withTitle: "Quit Karakeep", action: #selector(quitApp), keyEquivalent: "q").target =
      self
    appItem.submenu = app
    menu.addItem(appItem)
    let editItem = NSMenuItem()
    let edit = NSMenu(title: "Edit")
    for (title, action, key) in [
      ("Undo", Selector(("undo:")), "z"),
      ("Cut", #selector(NSText.cut(_:)), "x"),
      ("Copy", #selector(NSText.copy(_:)), "c"),
      ("Paste", #selector(NSText.paste(_:)), "v"),
      ("Select All", #selector(NSText.selectAll(_:)), "a"),
    ] { edit.addItem(withTitle: title, action: action, keyEquivalent: key) }
    editItem.submenu = edit
    menu.addItem(editItem)
    NSApp.mainMenu = menu
  }
}

final class StatusDropView: NSView {
  var clicked: ((Bool) -> Void)?
  var receivedFiles: (([URL]) -> Bool)?
  var canDrop: (() -> Bool)?
  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    registerForDraggedTypes([.fileURL])
    setAccessibilityElement(true)
    setAccessibilityRole(.button)
    setAccessibilityLabel("Karakeep Capture")
    setAccessibilityIdentifier("karakeepStatusItem")
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) {}
  override func rightMouseDown(with event: NSEvent) {}
  override func mouseUp(with event: NSEvent) { clicked?(event.modifierFlags.contains(.control)) }
  override func rightMouseUp(with event: NSEvent) { clicked?(true) }
  override func accessibilityPerformPress() -> Bool {
    clicked?(false)
    return true
  }
  override func accessibilityPerformShowMenu() -> Bool {
    clicked?(true)
    return true
  }
  override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
    guard canDrop?() == true, !fileURLs(sender).isEmpty else { return [] }
    (superview as? NSButton)?.highlight(true)
    return .copy
  }
  override func draggingExited(_ sender: (any NSDraggingInfo)?) {
    (superview as? NSButton)?.highlight(false)
  }
  override func draggingEnded(_ sender: any NSDraggingInfo) {
    (superview as? NSButton)?.highlight(false)
  }
  override func prepareForDragOperation(_ sender: any NSDraggingInfo) -> Bool {
    canDrop?() == true && !fileURLs(sender).isEmpty
  }
  override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
    (superview as? NSButton)?.highlight(false)
    return receivedFiles?(fileURLs(sender)) ?? false
  }
  private func fileURLs(_ sender: any NSDraggingInfo) -> [URL] {
    sender.draggingPasteboard.readObjects(
      forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
  }
}
