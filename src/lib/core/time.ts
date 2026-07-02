// Mailgun's analytics endpoints require RFC 2822 with a numeric UTC offset, not ISO 8601 and not the "GMT" suffix from Date#toUTCString().
export function toRfc2822Date(input: number | string): string {
  const ms = typeof input === 'number' ? input : Date.parse(input);
  const d = new Date(ms);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = days[d.getUTCDay()];
  const date = String(d.getUTCDate()).padStart(2, '0');
  const month = months[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${day}, ${date} ${month} ${year} ${hh}:${mm}:${ss} -0000`;
}
