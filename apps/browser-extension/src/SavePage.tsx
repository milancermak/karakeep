import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BookmarkPlus, Link2 } from "lucide-react";
import { Navigate } from "react-router-dom";
import superjson from "superjson";

import {
  BookmarkTypes,
  ZNewBookmarkRequest,
  zNewBookmarkRequestSchema,
  zBookmarkSchema,
  ZBookmark,
} from "@karakeep/shared/types/bookmarks";

import { NEW_BOOKMARK_REQUEST_KEY_NAME } from "./background/protocol";
import { parseXTarget } from "./content-scripts/x-capture";
import { StatusMessage } from "./components/StatusMessage";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import Spinner from "./Spinner";
import { hasHostPermission } from "./utils/permissions";
import usePluginSettings from "./utils/settings";
import {
  capturePageWithSingleFile,
  uploadSingleFileAsset,
} from "./utils/singlefile";
import { useTRPC } from "./utils/trpc";
import { MessageType } from "./utils/type";
import { isHttpUrl } from "./utils/url";

export default function SavePage() {
  const api = useTRPC();
  const { settings, isPending: isSettingsLoaded } = usePluginSettings();
  const [error, setError] = useState<string | undefined>(undefined);
  const [isCapturing, setIsCapturing] = useState(false);
  const closeAfterSave = useRef(false);
  const [titleIsCustom, setTitleIsCustom] = useState(false);
  const [pendingBookmark, setPendingBookmark] =
    useState<ZNewBookmarkRequest | null>(null);
  const [hasCheckedRequest, setHasCheckedRequest] = useState(false);
  const [currentTabId, setCurrentTabId] = useState<number | undefined>(
    undefined,
  );
  const [currentTabUrl, setCurrentTabUrl] = useState<string | undefined>(
    undefined,
  );
  const bookmarkUrl =
    pendingBookmark?.type === BookmarkTypes.LINK
      ? (parseXTarget(pendingBookmark.url)?.url ?? pendingBookmark.url)
      : undefined;
  const existingBookmark = useQuery(
    api.bookmarks.checkUrl.queryOptions(
      { url: bookmarkUrl ?? "" },
      {
        enabled: hasCheckedRequest && bookmarkUrl !== undefined,
        staleTime: 0,
        refetchOnWindowFocus: false,
        retry: false,
      },
    ),
  );
  const isCheckingBookmark =
    bookmarkUrl !== undefined &&
    (existingBookmark.isPending || existingBookmark.isFetching);

  const createOptions = api.bookmarks.createBookmark.mutationOptions({
    onError: (e) => {
      setError(e.message);
    },
    onSuccess: async () => {
      // After successful creation, update badge cache and notify background
      try {
        const [currentTab] = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        await chrome.runtime.sendMessage({
          type: MessageType.BOOKMARK_REFRESH_BADGE,
          currentTab: currentTab,
        });
      } catch {
        // Badge refresh is best-effort — on Firefox Android the background
        // script may not be reachable from the popup context.
      }
      if (closeAfterSave.current) window.close();
    },
  });
  const {
    data,
    mutate: createBookmark,
    status,
  } = useMutation({
    ...createOptions,
    mutationFn: async (bookmark: ZNewBookmarkRequest, context) => {
      if (bookmark.type === BookmarkTypes.LINK && parseXTarget(bookmark.url)) {
        setIsCapturing(true);
        try {
          const response = await chrome.runtime.sendMessage({
            type: "KARAKEEP_SAVE_X",
            bookmark,
            tabId: currentTabId,
            titleIsCustom,
          });
          if (!response?.success)
            throw new Error(response?.error || "Couldn't capture this X page");
          const saved = superjson.deserialize<
            ZBookmark & { alreadyExists: boolean }
          >(response.bookmark);
          return {
            ...zBookmarkSchema.parse(saved),
            alreadyExists: saved.alreadyExists,
          };
        } finally {
          setIsCapturing(false);
        }
      }
      return createOptions.mutationFn!(bookmark, context);
    },
  });

  useEffect(() => {
    async function getNewBookmarkRequestFromBackgroundScriptIfAny(): Promise<ZNewBookmarkRequest | null> {
      const { [NEW_BOOKMARK_REQUEST_KEY_NAME]: req } =
        await chrome.storage.session.get(NEW_BOOKMARK_REQUEST_KEY_NAME);
      if (!req) {
        return null;
      }
      // Delete the request immediately to avoid issues with lingering values
      await chrome.storage.session.remove(NEW_BOOKMARK_REQUEST_KEY_NAME);
      return zNewBookmarkRequestSchema.parse(req);
    }

    async function loadBookmarkRequest() {
      const [currentTab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      setCurrentTabId(currentTab?.id);
      setCurrentTabUrl(currentTab?.url);

      let newBookmarkRequest =
        await getNewBookmarkRequestFromBackgroundScriptIfAny();
      if (!newBookmarkRequest) {
        if (!currentTab?.url) {
          setError("This tab doesn't have a link to save.");
          setHasCheckedRequest(true);
          return;
        }

        if (!isHttpUrl(currentTab.url)) {
          setError("Only web pages (http:// and https:// links) can be saved.");
          setHasCheckedRequest(true);
          return;
        }

        newBookmarkRequest = {
          type: BookmarkTypes.LINK,
          title: currentTab.title,
          url: currentTab.url,
          source: "extension",
        };
      }

      if (
        newBookmarkRequest.type === BookmarkTypes.LINK &&
        currentTab?.id !== undefined &&
        parseXTarget(newBookmarkRequest.url)?.id ===
          parseXTarget(currentTab.url ?? "")?.id &&
        parseXTarget(newBookmarkRequest.url)
      ) {
        const titles = await chrome.scripting
          .executeScript({
            target: { tabId: currentTab.id },
            func: () =>
              document
                .querySelector(
                  '[data-testid="primaryColumn"] [data-testid="twitter-article-title"]',
                )
                ?.textContent?.trim() || null,
          })
          .catch(() => []);
        if (titles[0]?.result) newBookmarkRequest.title = titles[0].result;
      }
      setPendingBookmark(newBookmarkRequest);
      setHasCheckedRequest(true);
    }

    if (!isSettingsLoaded) return;
    loadBookmarkRequest();
  }, [isSettingsLoaded]);

  const saveBookmark = async (bookmark: ZNewBookmarkRequest) => {
    setError(undefined);
    let finalBookmark = bookmark;
    // Only crawl when the bookmark target matches the active tab — context-menu
    // saves (link/src URL) may create a bookmark for a different URL, in which
    // case capturing the current page would attach the wrong archive.
    if (
      settings.useSingleFile &&
      !(bookmark.type === BookmarkTypes.LINK && parseXTarget(bookmark.url)) &&
      currentTabId !== undefined &&
      bookmark.type === BookmarkTypes.LINK &&
      !bookmark.precrawledArchiveId &&
      currentTabUrl !== undefined &&
      bookmark.url === currentTabUrl &&
      // The `<all_urls>` host permission is optional and only granted when the
      // user opts in to client-side crawling; it may have been revoked since.
      (await hasHostPermission())
    ) {
      try {
        setIsCapturing(true);
        const html = await capturePageWithSingleFile(currentTabId, {
          includeImages: settings.singleFileIncludeImages,
        });
        const precrawledArchiveId = await uploadSingleFileAsset(
          html,
          bookmark.title ?? undefined,
        );
        finalBookmark = { ...bookmark, precrawledArchiveId };
      } catch (e) {
        // Client-side crawling is best-effort — fall back to a plain bookmark
        // so users can still save links on pages where capture is blocked.
        console.warn("Client-side crawl failed, saving without archive:", e);
      } finally {
        setIsCapturing(false);
      }
    }
    createBookmark({
      ...finalBookmark,
      source: finalBookmark.source || "extension",
    });
  };

  // Auto-save when settings are loaded and we have a pending bookmark
  useEffect(() => {
    if (
      hasCheckedRequest &&
      pendingBookmark &&
      settings.autoSave &&
      status === "idle" &&
      !isCapturing &&
      !isCheckingBookmark &&
      !existingBookmark.error &&
      !existingBookmark.data?.bookmarkId &&
      !error
    ) {
      saveBookmark(pendingBookmark);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hasCheckedRequest,
    pendingBookmark,
    settings.autoSave,
    status,
    isCapturing,
    isCheckingBookmark,
    existingBookmark.error,
    existingBookmark.data?.bookmarkId,
    error,
  ]);

  const isSaving = isCheckingBookmark || isCapturing || status === "pending";
  const saveError = error ?? existingBookmark.error?.message;

  const handleManualSave = async (closeOnSuccess = false) => {
    if (pendingBookmark && !isSaving) {
      closeAfterSave.current = closeOnSuccess;
      if (existingBookmark.error) {
        const result = await existingBookmark.refetch();
        if (result.error || result.data?.bookmarkId || settings.autoSave) {
          return;
        }
      }
      saveBookmark(pendingBookmark);
    }
  };

  const handleSaveShortcut = (
    e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey) &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      handleManualSave(true);
    }
  };

  if (existingBookmark.data?.bookmarkId) {
    return <Navigate to={`/bookmark/${existingBookmark.data.bookmarkId}`} />;
  }

  if (status === "success") {
    return <Navigate to={`/bookmark/${data.id}`} />;
  }

  if (!pendingBookmark || !hasCheckedRequest) {
    return error ? (
      <p role="alert" className="break-words text-sm text-destructive">
        {error}
      </p>
    ) : (
      <StatusMessage label="Loading…" />
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        handleManualSave();
      }}
    >
      <fieldset disabled={isSaving} className="flex min-w-0 flex-col gap-4">
        {pendingBookmark.type === BookmarkTypes.LINK && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="bookmark-title" className="text-sm font-medium">
              Title
            </label>
            <Input
              id="bookmark-title"
              onKeyDown={handleSaveShortcut}
              value={pendingBookmark.title ?? ""}
              onChange={(e) => {
                setTitleIsCustom(true);
                setPendingBookmark((prev) =>
                  prev ? { ...prev, title: e.target.value } : prev,
                );
              }}
              placeholder="Untitled"
            />
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Link2 className="size-3.5 shrink-0" />
              <span className="truncate">{pendingBookmark.url}</span>
            </p>
          </div>
        )}
        {pendingBookmark.type === BookmarkTypes.TEXT && (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Text</span>
            <p className="line-clamp-4 whitespace-pre-wrap rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              {pendingBookmark.text}
            </p>
          </div>
        )}
        {pendingBookmark.type === BookmarkTypes.ASSET && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="bookmark-title" className="text-sm font-medium">
              Title
            </label>
            <Input
              id="bookmark-title"
              onKeyDown={handleSaveShortcut}
              value={pendingBookmark.title ?? ""}
              onChange={(e) =>
                setPendingBookmark((prev) =>
                  prev ? { ...prev, title: e.target.value } : prev,
                )
              }
              placeholder={pendingBookmark.fileName ?? "Asset"}
            />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="bookmark-note" className="text-sm font-medium">
            Note{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </label>
          <Textarea
            id="bookmark-note"
            onKeyDown={handleSaveShortcut}
            value={pendingBookmark.note ?? ""}
            onChange={(e) =>
              setPendingBookmark((prev) =>
                prev ? { ...prev, note: e.target.value } : prev,
              )
            }
            placeholder="Why are you saving this?"
            className="h-20 resize-none"
          />
        </div>
        {(!settings.autoSave ||
          status === "error" ||
          existingBookmark.error) && (
          <Button type="submit" className="w-full gap-2">
            <BookmarkPlus aria-hidden="true" className="size-4" />
            {existingBookmark.error ? "Try again" : "Save bookmark"}
          </Button>
        )}
      </fieldset>
      {isSaving && (
        <p
          role="status"
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <Spinner className="size-3.5" />
          {isCheckingBookmark
            ? "Checking…"
            : isCapturing
              ? "Capturing…"
              : "Saving…"}
        </p>
      )}
      {saveError && !isCheckingBookmark && (
        <p role="alert" className="break-words text-sm text-destructive">
          {saveError}
        </p>
      )}
    </form>
  );
}
