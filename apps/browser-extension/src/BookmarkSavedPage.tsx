import { Check } from "lucide-react";
import { useParams } from "react-router-dom";

import BookmarkLists from "./components/BookmarkLists";
import { ErrorCallout } from "./components/ErrorCallout";
import { ListsSelector } from "./components/ListsSelector";
import { NoteEditor } from "./components/NoteEditor";
import TagList from "./components/TagList";
import { TagsSelector } from "./components/TagsSelector";
import { TitleEditor } from "./components/TitleEditor";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

export default function BookmarkSavedPage() {
  const { bookmarkId } = useParams();

  if (!bookmarkId) {
    return (
      <ErrorCallout title="Bookmark not found">
        This bookmark doesn&apos;t exist.
      </ErrorCallout>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Section title="Title">
        <TitleEditor bookmarkId={bookmarkId} />
      </Section>
      <Section title="Note">
        <NoteEditor bookmarkId={bookmarkId} />
      </Section>
      <Section title="Tags">
        <div className="flex flex-wrap items-center gap-1.5">
          <TagList bookmarkId={bookmarkId} />
          <TagsSelector bookmarkId={bookmarkId} />
        </div>
      </Section>
      <Section title="Lists">
        <div className="flex flex-col divide-y overflow-hidden rounded-lg border bg-card">
          {/* The picker sits above the lists so adding one doesn't push it
              (and its open dropdown) down. */}
          <ListsSelector bookmarkId={bookmarkId} />
          <BookmarkLists bookmarkId={bookmarkId} />
        </div>
      </Section>
      <p
        role="status"
        className="flex items-center gap-1 text-xs text-muted-foreground"
      >
        <Check
          aria-hidden="true"
          className="size-3.5 text-green-600 dark:text-green-500"
        />
        Saved
      </p>
    </div>
  );
}
