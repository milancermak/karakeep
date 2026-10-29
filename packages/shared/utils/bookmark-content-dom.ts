export function isBookmarkOwnerNote(node: Node) {
  return !!(
    node.nodeType === 1 ? (node as Element) : node.parentElement
  )?.closest("[data-karakeep-owner-note]");
}

export function createBookmarkSourceTextWalker(container: Node) {
  const { SHOW_TEXT, FILTER_REJECT, FILTER_ACCEPT } =
    container.ownerDocument!.defaultView!.NodeFilter;
  return container.ownerDocument!.createTreeWalker(container, SHOW_TEXT, {
    acceptNode: (node) =>
      isBookmarkOwnerNote(node) ? FILTER_REJECT : FILTER_ACCEPT,
  });
}
