// Giờ yên lặng: phòng chỉ được phát trong các khung giờ cho phép, vào các ngày cho phép (giờ máy chủ).
// quiet = { enabled, days: [0..6] (0 = Chủ nhật), ranges: [['08:00','12:00'], ...] }
export function isOpen(date, quiet) {
  if (!quiet?.enabled) return true;
  if (!quiet.days.includes(date.getDay())) return false;
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return quiet.ranges.some(([from, to]) => hm >= from && hm < to);
}

export const QUIET_NAME = 'Giờ yên lặng';
