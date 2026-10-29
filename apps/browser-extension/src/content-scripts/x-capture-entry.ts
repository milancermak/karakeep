import { captureXPage } from "./x-capture";

declare global {
  interface Window {
    __karakeepXCaptureLoaded__?: boolean;
  }
}

if (!window.__karakeepXCaptureLoaded__) {
  window.__karakeepXCaptureLoaded__ = true;
  let host: HTMLDivElement | undefined;
  let dialog: HTMLDialogElement | undefined;
  let label: HTMLParagraphElement | undefined;
  let button: HTMLButtonElement | undefined;
  let controller: AbortController | undefined;

  const close = () => {
    dialog?.close();
    host?.remove();
    host = undefined;
    dialog = undefined;
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "KARAKEEP_CAPTURE_X") {
      if (host) {
        sendResponse({
          success: false,
          error: "X capture is already in progress",
        });
        return;
      }
      controller = new AbortController();
      host = document.createElement("div");
      host.id = "karakeep-x-capture";
      const root = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        :host { color-scheme: light dark; }
        dialog { box-sizing: border-box; position: fixed; inset: 0; margin: auto; inline-size: min(26rem, calc(100% - 2rem)); border: 1px solid light-dark(#ddd, #444); border-radius: 1rem; padding: 2rem; background: light-dark(#fff, #181818); color: light-dark(#171717, #fafafa); box-shadow: 0 1rem 4rem rgb(0 0 0 / .2); font: 500 1rem/1.5 system-ui, sans-serif; text-align: center; }
        dialog::backdrop { background: rgb(0 0 0 / .35); backdrop-filter: blur(3px); }
        p { margin-block: 0 1.5rem; overflow-wrap: anywhere; }
        button { min-block-size: 2.75rem; border: 1px solid light-dark(#ccc, #555); border-radius: .5rem; padding-inline: 1.25rem; background: transparent; color: inherit; font: inherit; cursor: pointer; }
        button:focus-visible { outline: 2px solid light-dark(#171717, #fafafa); outline-offset: 3px; }
      `;
      dialog = document.createElement("dialog");
      label = document.createElement("p");
      label.id = "capture-status";
      label.setAttribute("role", "status");
      label.textContent = "Capturing X…";
      dialog.setAttribute("aria-labelledby", label.id);
      button = document.createElement("button");
      button.type = "button";
      button.textContent = "Cancel";
      button.onclick = () => {
        controller?.abort();
        close();
      };
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        controller?.abort();
        close();
      });
      dialog.append(label, button);
      root.append(style, dialog);
      document.documentElement.append(host);
      dialog.showModal();
      captureXPage({
        signal: controller.signal,
        onProgress: (progress) => {
          if (label) label.textContent = progress.label;
        },
      })
        .then((capture) => sendResponse({ success: true, capture }))
        .catch((error) =>
          sendResponse({
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Couldn't capture this X page",
          }),
        );
      return true;
    }
    if (message.type === "KARAKEEP_X_STATUS") {
      if (label) label.textContent = message.label;
      if (button) button.hidden = true;
      sendResponse({ success: true });
    } else if (message.type === "KARAKEEP_X_FINISH") {
      if (!host) return;
      if (label)
        label.textContent = message.success
          ? "Saved to Karakeep"
          : message.error;
      if (message.success) {
        setTimeout(close, 800);
      } else if (button) {
        button.hidden = false;
        button.textContent = "Close";
        button.onclick = close;
      }
      sendResponse({ success: true });
    }
  });
}
