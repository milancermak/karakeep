// @vitest-environment jsdom
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import superjson from "superjson";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { TRPCSettingsProvider } from "@karakeep/shared-react/providers/trpc-provider";

import SavePage from "../src/SavePage";

const mocks = vi.hoisted(() => ({
  settings: {
    address: "https://karakeep.example.invalid",
    apiKey: "test-key",
    autoSave: true,
    useSingleFile: true,
    singleFileIncludeImages: true,
    showCountBadge: false,
  },
  capture: vi.fn(),
  upload: vi.fn(),
  permission: vi.fn(),
}));

vi.mock("../src/utils/settings", () => ({
  default: () => ({ settings: mocks.settings, isPending: true }),
}));
vi.mock("../src/utils/trpc", async () => ({
  useTRPC: (await import("@karakeep/shared-react/trpc")).useTRPC,
}));
vi.mock("../src/utils/singlefile", () => ({
  capturePageWithSingleFile: mocks.capture,
  uploadSingleFileAsset: mocks.upload,
}));
vi.mock("../src/utils/permissions", () => ({
  hasHostPermission: mocks.permission,
}));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let tabUrl: string;
let queuedRequest: Record<string, unknown> | undefined;
let check: (url: string) => Promise<string | null>;
let create: ReturnType<typeof vi.fn>;
let requests: { route: string; input: Record<string, unknown> }[];
let sendMessage: ReturnType<typeof vi.fn>;

function SavedBookmark() {
  return <p>Existing editor: {useParams().bookmarkId}</p>;
}

async function renderPopup() {
  await act(async () => {
    root.render(
      <TRPCSettingsProvider settings={mocks.settings} queryClient={queryClient}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<SavePage />} />
            <Route path="/bookmark/:bookmarkId" element={<SavedBookmark />} />
          </Routes>
        </MemoryRouter>
      </TRPCSettingsProvider>,
    );
  });
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assertion();
  });
}

async function clickSubmit() {
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('button[type="submit"]')!
      .click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.settings.autoSave = true;
  mocks.settings.useSingleFile = true;
  mocks.capture.mockResolvedValue("<html>Captured</html>");
  mocks.upload.mockResolvedValue("archive-id");
  mocks.permission.mockResolvedValue(true);
  tabUrl = "https://example.org/article";
  queuedRequest = undefined;
  check = async () => null;
  create = vi.fn(async () => ({ id: "new-bookmark", alreadyExists: false }));
  vi.spyOn(window, "close").mockReturnValue(undefined);
  requests = [];
  sendMessage = vi.fn(async () => undefined);
  vi.stubGlobal("chrome", {
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: tabUrl, title: "Tab title" }]),
    },
    storage: {
      session: {
        get: vi.fn(async () => ({ "karakeep-new-bookmark": queuedRequest })),
        remove: vi.fn(async () => undefined),
      },
    },
    scripting: { executeScript: vi.fn(async () => []) },
    runtime: { sendMessage },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const parsed = new URL(String(url));
      const routes = parsed.pathname.split("/api/trpc/")[1].split(",");
      const input = JSON.parse(
        String(options?.body || parsed.searchParams.get("input") || "{}"),
      );
      const results = await Promise.all(
        routes.map(async (route, index) => {
          const data = input[index]?.json;
          requests.push({ route, input: data });
          try {
            let result;
            if (route === "bookmarks.checkUrl")
              result = { bookmarkId: await check(data.url) };
            else if (route === "bookmarks.createBookmark")
              result = await create();
            else throw new Error(`Unexpected request: ${route}`);
            return { result: { data: superjson.serialize(result) } };
          } catch (error) {
            return {
              error: {
                json: {
                  message: (error as Error).message,
                  code: -32603,
                  data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
                },
              },
            };
          }
        }),
      );
      return new Response(JSON.stringify(results), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("popup keyboard submission", () => {
  test.each([
    { field: "input", modifier: "Command", metaKey: true, ctrlKey: false },
    { field: "textarea", modifier: "Command", metaKey: true, ctrlKey: false },
    { field: "input", modifier: "Control", metaKey: false, ctrlKey: true },
    { field: "textarea", modifier: "Control", metaKey: false, ctrlKey: true },
  ])(
    "$modifier+Enter saves from the $field and closes the popup",
    async ({ field, metaKey, ctrlKey }) => {
      mocks.settings.autoSave = false;
      queuedRequest = {
        type: "link",
        url: tabUrl,
        title: "Custom title",
        note: "A note to keep",
        source: "extension",
      };
      await renderPopup();
      await waitFor(() =>
        expect(container.querySelector("fieldset")?.disabled).toBe(false),
      );
      await act(async () => {
        container.querySelector(field)!.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            metaKey,
            ctrlKey,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await waitFor(() => expect(window.close).toHaveBeenCalledTimes(1));
      const saves = requests.filter(
        (request) => request.route === "bookmarks.createBookmark",
      );
      expect(saves).toHaveLength(1);
      expect(saves[0].input).toMatchObject({
        title: "Custom title",
        note: "A note to keep",
      });
      expect(mocks.capture).toHaveBeenCalledTimes(1);
    },
  );

  test("keeps the popup open while saving and after a failed keyboard save", async () => {
    mocks.settings.autoSave = false;
    let rejectSave!: (error: Error) => void;
    create.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSave = reject;
        }),
    );
    await renderPopup();
    await waitFor(() =>
      expect(container.querySelector("fieldset")?.disabled).toBe(false),
    );
    await act(async () => {
      container.querySelector("textarea")!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(window.close).not.toHaveBeenCalled();
    await act(async () => rejectSave(new Error("Could not save bookmark")));
    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Could not save bookmark",
      ),
    );
    expect(window.close).not.toHaveBeenCalled();

    await clickSubmit();
    await waitFor(() =>
      expect(container.textContent).toContain("Existing editor: new-bookmark"),
    );
    expect(window.close).not.toHaveBeenCalled();
  });

  test.each([
    { key: "Enter", metaKey: false, isComposing: false },
    { key: "composing Command+Enter", metaKey: true, isComposing: true },
  ])(
    "$key keeps the note editable without saving",
    async ({ metaKey, isComposing }) => {
      mocks.settings.autoSave = false;
      await renderPopup();
      await waitFor(() =>
        expect(container.querySelector("fieldset")?.disabled).toBe(false),
      );
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey,
        isComposing,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        container.querySelector("textarea")!.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(requests.map((request) => request.route)).toEqual([
        "bookmarks.checkUrl",
      ]);
      expect(mocks.capture).not.toHaveBeenCalled();
    },
  );
});

describe("popup duplicate detection", () => {
  test.each([true, false])(
    "opens the existing editor before saving (auto-save %s, badge off)",
    async (autoSave) => {
      mocks.settings.autoSave = autoSave;
      check = async () => "existing-bookmark";
      await renderPopup();
      await waitFor(() =>
        expect(container.textContent).toContain(
          "Existing editor: existing-bookmark",
        ),
      );
      expect(requests.map((request) => request.route)).toEqual([
        "bookmarks.checkUrl",
      ]);
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.upload).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  test("waits for the lookup before capturing or auto-saving a new page", async () => {
    let resolveLookup!: (value: string | null) => void;
    check = () =>
      new Promise((resolve) => {
        resolveLookup = resolve;
      });
    await renderPopup();
    await waitFor(() =>
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        "Checking…",
      ),
    );
    expect(container.querySelector("input")?.matches(":disabled")).toBe(true);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(requests.map((request) => request.route)).toEqual([
      "bookmarks.checkUrl",
    ]);
    await act(async () => resolveLookup(null));
    await waitFor(() =>
      expect(container.textContent).toContain("Existing editor: new-bookmark"),
    );
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(
      requests.filter(
        (request) => request.route === "bookmarks.createBookmark",
      ),
    ).toHaveLength(1);
  });

  test("checks the canonical X URL before starting the background capture", async () => {
    tabUrl = "https://mobile.twitter.com/author/status/200/photo/1?s=20";
    check = async () => "existing-x-bookmark";
    await renderPopup();
    await waitFor(() =>
      expect(container.textContent).toContain(
        "Existing editor: existing-x-bookmark",
      ),
    );
    expect(requests[0].input).toEqual({
      url: "https://x.com/author/status/200",
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  test("checks a context-menu link rather than its surrounding tab", async () => {
    queuedRequest = {
      type: "link",
      url: "https://example.org/linked-article",
      source: "extension",
    };
    check = async () => "existing-link";
    await renderPopup();
    await waitFor(() =>
      expect(container.textContent).toContain("Existing editor: existing-link"),
    );
    expect(requests[0].input).toEqual({
      url: "https://example.org/linked-article",
    });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  test("selected text is still saved as a new text bookmark", async () => {
    queuedRequest = {
      type: "text",
      text: "Selected text",
      source: "extension",
    };
    await renderPopup();
    await waitFor(() =>
      expect(container.textContent).toContain("Existing editor: new-bookmark"),
    );
    expect(requests.map((request) => request.route)).toEqual([
      "bookmarks.createBookmark",
    ]);
    expect(requests[0].input.type).toBe("text");
  });

  test.each([true, false])(
    "retries a failed check without saving twice (auto-save %s)",
    async (autoSave) => {
      mocks.settings.autoSave = autoSave;
      let attempts = 0;
      check = async () => {
        if (++attempts === 1) throw new Error("Could not check saved pages");
        return null;
      };
      await renderPopup();
      await waitFor(() =>
        expect(
          container.querySelector('[role="alert"]')?.textContent,
        ).toContain("Could not check saved pages"),
      );
      expect(requests).toHaveLength(1);
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(container.querySelector("form")).not.toBeNull();
      expect(container.querySelector("button")?.textContent).toContain(
        "Try again",
      );
      await clickSubmit();
      await waitFor(() =>
        expect(container.textContent).toContain(
          "Existing editor: new-bookmark",
        ),
      );
      expect(attempts).toBe(2);
      expect(
        requests.filter(
          (request) => request.route === "bookmarks.createBookmark",
        ),
      ).toHaveLength(1);
    },
  );

  test("a retry that finds an existing bookmark never captures or saves it", async () => {
    let attempts = 0;
    check = async () => {
      if (++attempts === 1) throw new Error("Could not check saved pages");
      return "existing-bookmark";
    };
    await renderPopup();
    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')).not.toBeNull(),
    );
    await clickSubmit();
    await waitFor(() =>
      expect(container.textContent).toContain(
        "Existing editor: existing-bookmark",
      ),
    );
    expect(requests.map((request) => request.route)).toEqual([
      "bookmarks.checkUrl",
      "bookmarks.checkUrl",
    ]);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
