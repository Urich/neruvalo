import { useEffect, useRef, useState } from "react";
import { Entry, types } from "./model";
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
}: {
  nodes: TreeNode[];
  selected?: string;
  activeGroup: string | null;
  onEntry: (entry: Entry) => void;
  onGroup: (group: Group) => void;
  searching: boolean;
  reveal: number;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
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
  const render = (list: TreeNode[], level: number) =>
    list.map((node) => {
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
                  expanded ? "Свернуть группу" : "Развернуть группу",
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
                <Icon
                  name={node.group ? "folder" : node.entry!.data.record_type}
                />
              </span>
              <span>
                <strong>
                  <bdi>{node.group?.title ?? node.entry!.data.title}</bdi>
                </strong>
                <small>
                  {node.group
                    ? t("Группа")
                    : t(
                        types[node.entry!.data.record_type]?.label ??
                          "Неизвестный тип",
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
  return (
    <div role="tree" aria-label={t("Записи")} className="entry-tree" ref={ref}>
      {render(nodes, 1)}
    </div>
  );
}
