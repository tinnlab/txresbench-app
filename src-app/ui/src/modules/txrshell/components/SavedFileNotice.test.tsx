// @vitest-environment jsdom
//
// SavedFileNotice: after a desktop save, one status line names the file and
// its "Show in Finder"/"Show in folder" button opens the file's folder through
// the desktop `reveal_in_file_manager` command.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SavedFileNotice } from './SavedFileNotice'

afterEach(() => {
  cleanup()
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
  vi.restoreAllMocks()
})

describe('SavedFileNotice', () => {
  it('names the saved path in a status line', () => {
    render(<SavedFileNotice path="/Users/me/Desktop/predictions-run-1.csv" testId="saved" />)
    const line = screen.getByTestId('saved')
    expect(line.getAttribute('role')).toBe('status')
    expect(line.textContent).toContain('Saved to /Users/me/Desktop/predictions-run-1.csv')
  })

  it('opens the file\'s folder from its button', async () => {
    const invoke = vi.fn(() => Promise.resolve(undefined))
    ;(window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } }
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')
    render(<SavedFileNotice path="/Users/me/Desktop/predictions-run-1.csv" testId="saved" />)
    const show = screen.getByTestId('saved-show')
    expect(show.textContent).toBe('Show in Finder')
    fireEvent.click(show)
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledWith('reveal_in_file_manager', { path: '/Users/me/Desktop' })
  })
})
