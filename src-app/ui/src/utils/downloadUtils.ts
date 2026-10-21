/**
 * Utility functions for download and file size formatting
 */

/**
 * Format bytes to human-readable string
 * @param bytes Number of bytes
 * @param decimals Number of decimal places (default: 2)
 * @returns Formatted string (e.g., "1.5 GB")
 */
export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return '0 Bytes'

  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']

  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
}

/**
 * Calculate download speed
 * @param bytesDownloaded Number of bytes downloaded
 * @param elapsedSeconds Elapsed time in seconds
 * @returns Speed in bytes per second
 */
export function calculateSpeed(
  bytesDownloaded: number,
  elapsedSeconds: number,
): number {
  if (elapsedSeconds === 0) return 0
  return bytesDownloaded / elapsedSeconds
}

/**
 * Format speed to human-readable string
 * @param bytesPerSecond Speed in bytes per second
 * @returns Formatted string (e.g., "5.2 MB/s")
 */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

/**
 * Estimate remaining time
 * @param bytesRemaining Remaining bytes to download
 * @param bytesPerSecond Current download speed
 * @returns Estimated time in seconds, or null if cannot estimate
 */
export function estimateTimeRemaining(
  bytesRemaining: number,
  bytesPerSecond: number,
): number | null {
  if (bytesPerSecond === 0) return null
  return bytesRemaining / bytesPerSecond
}

/**
 * Format time in seconds to human-readable string
 * @param seconds Time in seconds
 * @returns Formatted string (e.g., "2h 15m", "45s")
 */
export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return 'Unknown'

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`
  } else {
    return `${secs}s`
  }
}

/**
 * Format ETA (Estimated Time of Arrival) - alias for formatTime
 * @param seconds Time in seconds
 * @returns Formatted string (e.g., "2h 15m", "45s")
 */
export function formatETA(seconds: number): string {
  return formatTime(seconds)
}
