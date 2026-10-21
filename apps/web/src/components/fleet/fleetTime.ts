// magnesium: Fleet's times (goals 04 and 35): a time today as its clock time, an older one with its date
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export const formatTime = (iso: string) => {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? timeFormat.format(date)
    : dateTimeFormat.format(date);
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** A backup's time, as its list says it: "Today 3:40 AM", "Yesterday 3:38 AM", then the date. */
export const formatDay = (iso: string) => {
  const date = new Date(iso);
  const day = date.toDateString();
  if (day === new Date().toDateString()) return `Today ${timeFormat.format(date)}`;
  if (day === new Date(Date.now() - DAY_MS).toDateString()) {
    return `Yesterday ${timeFormat.format(date)}`;
  }
  return dateTimeFormat.format(date);
};

/** `formatDay` inside a sentence: "from yesterday 3:38 AM". */
export const formatDayInline = (iso: string) =>
  formatDay(iso).replace(/^(Today|Yesterday)/, (word) => word.toLowerCase());
