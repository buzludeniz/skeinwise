// The keys of a row of tabs, as the ARIA tabs pattern has them: the arrows move to the next tab and wrap at the ends,
// Home and End go to the first and the last.

/** The tab that `key` moves to from tab `at` in a row of `count`, or null when the key is not a tab key. */
export function tabStep(key: string, at: number, count: number): number | null {
  if (count < 1) return null;
  switch (key) {
    case 'ArrowRight':
      return (at + 1) % count;
    case 'ArrowLeft':
      return (at - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** The ids that tie a row's tabs to the panel under it. */
export const tabId = (row: string, key: string) => `${row}-tab-${key}`;
export const panelId = (row: string) => `${row}-panel`;

/** The attributes for the panel under a row of tabs, showing the tab `value`. */
export function tabPanel(row: string, value: string) {
  return { id: panelId(row), role: 'tabpanel', 'aria-labelledby': tabId(row, value) } as const;
}
