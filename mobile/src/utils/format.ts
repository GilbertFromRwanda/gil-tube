import { FormatEntry } from '../api/types';

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatDuration(totalSeconds: number | null | undefined): string {
  if (!totalSeconds && totalSeconds !== 0) return '';
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function formatLabel(format: FormatEntry): string {
  const parts: string[] = [];
  if (format.height) parts.push(`${format.height}p`);
  else parts.push('audio');
  if (format.container) parts.push(format.container);
  if (format.filesize) parts.push(formatBytes(format.filesize));
  return `${parts.join(' · ')} (${format.id})`;
}
