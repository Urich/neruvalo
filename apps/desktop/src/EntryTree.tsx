import { EntryIcon } from "./RecordIcon";
import { useEffect, useRef, useState } from "react";
import { Entry, types, passwordExpired } from "./model";
import { Group, TreeNode } from "./groups";
import { Icon } from "./Icon";
import { useI18n } from "./i18n";
export function EntryTree({
  nodes,
  selected,
  activeGroup,
  onEntry,
  onGroup,
  searching,
  reveal,
  resetKey = "",
  loading = false,
  loadKey = 0,
  loadFailed = false,
  onVisibleEntries,
}: {
  nodes: TreeNode[];
  selected?: string;
  activeGroup: string | null;
  onEntry: (entry: Entry) => void;
  onGroup: (group: Group) => void;
  searching: boolean;
  reveal: number;
  resetKey?: string;
  loading?: boolean;
  loadKey?: number;
  loadFailed?: boolean;
  onVisibleEntries?: (entries: Entry[]) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(50);
  useEffect(() => { setLimit(50); if (ref.current) ref.current.scrollTop = 0; }, [resetKey]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    const find = (list: TreeNode[], path: string[]): string[] | null => {
      for (const node of list) {
        const next = [...path, node.key];
        if (node.key === activeGroup) return next;
        const result = find(node.children, next);
        if (result) return result;
      }
      return null;
    };
    const path = find(nodes, []);
    if (path)
      setCollapsed((old) => {
        const next = new Set(old);
        path.forEach((id) => next.delete(id));
        return next;
      });
  }, [reveal, activeGroup]);
  const toggle = (id: string, close?: boolean) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (close ?? !old.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  // Render the selected entry and its ancestors even beyond the current page limit.
  const selectionPath = new Set<string>();
  const findSelection = (list: TreeNode[], path: string[]): boolean => list.some(node => {
    const next = [...path,node.key];
    if (node.key === selected) { next.forEach(key => selectionPath.add(key)); return true; }
    return findSelection(node.children,next);
  });
  if (selected) findSelection(nodes,[]);
  const scrolledSelection = useRef("");
  useEffect(() => {
    if (!selected) { scrolledSelection.current = ""; return; }
    const key = `${selected}:${reveal}`;
    if (scrolledSelection.current === key) return;
    const row = [...(ref.current?.querySelectorAll<HTMLElement>("[data-record-id]") ?? [])].find(element => element.dataset.recordId === selected);
    if (row) { row.scrollIntoView?.({block:"nearest"}); scrolledSelection.current=key; }
  },[selected,reveal,nodes,collapsed]);
  let rendered = 0;
  const visibleSummaries: Entry[] = [];
  const countVisible = (list: TreeNode[]): number => list.reduce((count,node) => count + 1 + (node.group && (searching || !collapsed.has(node.key)) ? countVisible(node.children) : 0), 0);
  const hasMore = countVisible(nodes) > limit;
  const render = (list: TreeNode[], level: number) =>
    list.map((node) => {
      if (rendered >= limit && !selectionPath.has(node.key)) return null;
      rendered++;
      if (node.entry?.summary && !node.entry.row_loaded) visibleSummaries.push(node.entry);
      const expanded = searching || !collapsed.has(node.key),
        selectedNode = node.group
          ? activeGroup === node.key && !selected
          : selected === node.key;
      return (
        <div
          key={node.key}
          role="treeitem"
          tabIndex={0}
          aria-level={level}
          aria-expanded={node.group ? expanded : undefined}
          aria-selected={selectedNode}
          data-tree-id={node.key}
          data-group-id={node.group?.id}
          data-record-id={node.entry?.record_id}
          className="tree-item"
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            const rows = [
              ...ref.current!.querySelectorAll<HTMLElement>(
                '[role="treeitem"]',
              ),
            ];
            const index = rows.indexOf(e.currentTarget);
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
              e.preventDefault();
              rows[
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? rows.length - 1
                    : Math.min(
                        rows.length - 1,
                        Math.max(0, index + (e.key === "ArrowDown" ? 1 : -1)),
                      )
              ]?.focus();
            }
            if (e.key === "ArrowRight") {
              e.preventDefault();
              if (node.group && !expanded) toggle(node.key, false);
              else
                e.currentTarget
                  .querySelector<HTMLElement>(
                    '[role="group"] > [role="treeitem"]',
                  )
                  ?.focus();
            }
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              if (node.group && expanded) toggle(node.key, true);
              else
                e.currentTarget.parentElement
                  ?.closest<HTMLElement>('[role="treeitem"]')
                  ?.focus();
            }
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (node.group) onGroup(node.group);
              else onEntry(node.entry!);
            }
          }}
        >
          <div
            className={selectedNode ? "tree-row selected" : "tree-row"}
            style={{
              paddingInlineStart: 12 + (level - 1) * 18,
              minWidth: 240 + (level - 1) * 18,
            }}
          >
            {node.group ? (
              <button
                tabIndex={-1}
                className="tree-toggle"
                aria-label={t(
                  expanded ? "ui.collapseGroup" : "ui.expandGroup",
                )}
                onClick={() => toggle(node.key)}
              >
                {expanded ? "▾" : "▸"}
              </button>
            ) : (
              <span className="tree-spacer" />
            )}
            <button
              tabIndex={-1}
              aria-label={node.group?.title ?? node.entry!.data.title}
              className={node.entry ? "record tree-record" : "tree-group"}
              onClick={() =>
                node.group ? onGroup(node.group) : onEntry(node.entry!)
              }
            >
              <span className="record-icon">
                <EntryIcon data={node.entry?.data ?? node.group ?? undefined} name={node.group ? "folder" : node.entry!.data.record_type} />
              </span>
              <span>
                <strong>
                  <bdi>{node.group?.title ?? node.entry!.data.title}</bdi>
                  {node.entry && passwordExpired(node.entry.data) && <span className="expired-indicator" role="img" aria-label={t("ui.passwordExpired")} title={t("ui.passwordExpired")}><Icon name="expired" /></span>}
                  {!!node.entry?.share_count && (
                    <span
                      className="shared-indicator"
                      aria-label={t("ui.sharedByMe")}
                    >
                      {" "}
                      · <Icon name="share" /> {node.entry.share_count}
                    </span>
                  )}
                </strong>
                <small>
                  {node.group
                    ? t("ui.group")
                    : t(
                        types[node.entry!.data.record_type]?.label ??
                          "ui.unknownType",
                      )}
                </small>
              </span>
            </button>
          </div>
          {node.group && expanded && node.children.length > 0 && (
            <div role="group">{render(node.children, level + 1)}</div>
          )}
        </div>
      );
    });
  const content = render(nodes, 1);
  const visibleKey = visibleSummaries.map(entry => `${entry.record_id}:${entry.version_id}`).join(",");
  useEffect(() => { if (visibleSummaries.length) onVisibleEntries?.(visibleSummaries); }, [visibleKey, loadKey]);
  useEffect(() => {
    const element = ref.current;
    if (hasMore && element && element.clientHeight > 0 && element.scrollHeight <= element.clientHeight) setLimit(value => value + 50);
  }, [limit, resetKey, nodes, collapsed]);
  return (
    <div role="tree" aria-label={t("ui.entries")} aria-busy={loading} className="entry-tree" ref={ref}
      onScroll={event => { const element = event.currentTarget; if (hasMore && element.scrollHeight-element.scrollTop-element.clientHeight < 160) setLimit(value => value + 50); }}>
      {content}
      {loading && <div role="status" className="records-loading"><span className="loading-spinner" aria-hidden="true" />{t("ui.loadingRecords")}</div>}
      {loadFailed && <button type="button" className="secondary full" onClick={() => onVisibleEntries?.(visibleSummaries)}>{t("ui.retryLoadingRecords")}</button>}
      {hasMore && <button type="button" className="secondary full" disabled={loading} onClick={() => setLimit(value => value + 50)}>{t("ui.loadMoreRecords")}</button>}
    </div>
  );
}
