export function getIstTimestamp(): string {
  const now = new Date();
  return now.toLocaleString('en-CA', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
  });
}

export function compactDateForRef(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}${get('second')}`;
}
