/**
 * Tests for `server/publish/staticArtefact.ts`.
 *
 * All tests use real filesystem operations in an OS tmpdir so that the
 * actual rename(2) / symlink / readlink syscall semantics are exercised.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFile, rm, stat } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getActiveSlot,
  getInactiveSlot,
  prepareInactiveSlot,
  readArtefact,
  removeArtefactInPlace,
  swapSlot,
  updateArtefactInPlace,
  writeArtefact,
} from '../../../server/publish/staticArtefact'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let uploadsDir: string
const SITE = 'default'

beforeEach(async () => {
  uploadsDir = await mkdtemp(join(tmpdir(), 'static-artefact-'))
})

afterEach(async () => {
  await rm(uploadsDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// URL-to-disk mapping
// ---------------------------------------------------------------------------

describe('url-to-disk mapping', () => {
  it('/ maps to index.html at the slot root', async () => {
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir, SITE)
    await writeArtefact(slotDir, '/', '<html>root</html>')
    await swapSlot(uploadsDir, SITE, slot)

    // File must be at <slotDir>/index.html
    const fileStat = await stat(join(slotDir, 'index.html'))
    expect(fileStat.isFile()).toBe(true)

    // Round-trip read returns same content
    const result = await readArtefact(uploadsDir, SITE, '/')
    expect(result).toBe('<html>root</html>')
  })

  it('/foo/ maps to foo/index.html', async () => {
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir, SITE)
    await writeArtefact(slotDir, '/foo/', '<html>foo dir</html>')
    await swapSlot(uploadsDir, SITE, slot)

    const fileStat = await stat(join(slotDir, 'foo', 'index.html'))
    expect(fileStat.isFile()).toBe(true)

    const result = await readArtefact(uploadsDir, SITE, '/foo/')
    expect(result).toBe('<html>foo dir</html>')
  })

  it('/foo/bar maps to foo/bar.html', async () => {
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir, SITE)
    await writeArtefact(slotDir, '/foo/bar', '<html>foo bar</html>')
    await swapSlot(uploadsDir, SITE, slot)

    const fileStat = await stat(join(slotDir, 'foo', 'bar.html'))
    expect(fileStat.isFile()).toBe(true)

    const result = await readArtefact(uploadsDir, SITE, '/foo/bar')
    expect(result).toBe('<html>foo bar</html>')
  })

  it('nested three-level paths are written and read back correctly', async () => {
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir, SITE)
    await writeArtefact(slotDir, '/a/b/c', '<html>deep</html>')
    await swapSlot(uploadsDir, SITE, slot)

    const fileStat = await stat(join(slotDir, 'a', 'b', 'c.html'))
    expect(fileStat.isFile()).toBe(true)

    const result = await readArtefact(uploadsDir, SITE, '/a/b/c')
    expect(result).toBe('<html>deep</html>')
  })
})

// ---------------------------------------------------------------------------
// Atomic write + readback
// ---------------------------------------------------------------------------

describe('atomic write + readback', () => {
  it('writeArtefact then readArtefact returns the same content', async () => {
    const html = '<html><head><title>Test</title></head><body>Hello World</body></html>'
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir, SITE)
    await writeArtefact(slotDir, '/about', html)
    await swapSlot(uploadsDir, SITE, slot)
    const result = await readArtefact(uploadsDir, SITE, '/about')
    expect(result).toBe(html)
  })

  it('per-file tmp+rename never leaves a .tmp file on success', async () => {
    const { slotDir } = await prepareInactiveSlot(uploadsDir, SITE)
    await writeArtefact(slotDir, '/page', '<html>page</html>')

    // The .tmp file must not exist after a successful write
    let tmpExists = false
    try {
      await stat(join(slotDir, 'page.html.tmp'))
      tmpExists = true
    } catch {
      // expected: file doesn't exist
    }
    expect(tmpExists).toBe(false)

    // The final file does exist
    const fileStat = await stat(join(slotDir, 'page.html'))
    expect(fileStat.isFile()).toBe(true)
  })

  it('overwriting a file leaves no .tmp behind', async () => {
    const { slotDir } = await prepareInactiveSlot(uploadsDir, SITE)
    await writeArtefact(slotDir, '/page', '<html>v1</html>')
    await writeArtefact(slotDir, '/page', '<html>v2</html>')

    let tmpExists = false
    try {
      await stat(join(slotDir, 'page.html.tmp'))
      tmpExists = true
    } catch {
      // expected
    }
    expect(tmpExists).toBe(false)

    // Final content is the second write
    const content = await readFile(join(slotDir, 'page.html'), 'utf-8')
    expect(content).toBe('<html>v2</html>')
  })
})

// ---------------------------------------------------------------------------
// Symlink swap semantics
// ---------------------------------------------------------------------------

describe('symlink swap semantics', () => {
  it('getActiveSlot returns "a" by default when no symlink exists', async () => {
    const slot = await getActiveSlot(uploadsDir, SITE)
    expect(slot).toBe('a')
  })

  it('getInactiveSlot returns "b" by default when no symlink exists', async () => {
    const slot = await getInactiveSlot(uploadsDir, SITE)
    expect(slot).toBe('b')
  })

  it('after swapSlot("a"), getActiveSlot returns "a"', async () => {
    await swapSlot(uploadsDir, SITE, 'a')
    expect(await getActiveSlot(uploadsDir, SITE)).toBe('a')
  })

  it('after swapSlot("b"), getActiveSlot returns "b"', async () => {
    await swapSlot(uploadsDir, SITE, 'b')
    expect(await getActiveSlot(uploadsDir, SITE)).toBe('b')
  })

  it('swapSlot("a") then swapSlot("b") — getActiveSlot reflects each', async () => {
    await swapSlot(uploadsDir, SITE, 'a')
    expect(await getActiveSlot(uploadsDir, SITE)).toBe('a')

    await swapSlot(uploadsDir, SITE, 'b')
    expect(await getActiveSlot(uploadsDir, SITE)).toBe('b')
  })

  it('getInactiveSlot is always the complement of getActiveSlot', async () => {
    await swapSlot(uploadsDir, SITE, 'a')
    expect(await getInactiveSlot(uploadsDir, SITE)).toBe('b')

    await swapSlot(uploadsDir, SITE, 'b')
    expect(await getInactiveSlot(uploadsDir, SITE)).toBe('a')
  })

  it('reader sees content from the new slot immediately after swap', async () => {
    // First publish
    const { slot: s1, slotDir: sd1 } = await prepareInactiveSlot(uploadsDir, SITE)
    await writeArtefact(sd1, '/home', '<html>v1</html>')
    await swapSlot(uploadsDir, SITE, s1)
    expect(await readArtefact(uploadsDir, SITE, '/home')).toBe('<html>v1</html>')

    // Second publish
    const { slot: s2, slotDir: sd2 } = await prepareInactiveSlot(uploadsDir, SITE)
    await writeArtefact(sd2, '/home', '<html>v2</html>')
    await swapSlot(uploadsDir, SITE, s2)
    expect(await readArtefact(uploadsDir, SITE, '/home')).toBe('<html>v2</html>')

    // Slots must have alternated
    expect(s1).not.toBe(s2)
  })
})

// ---------------------------------------------------------------------------
// Slot rotation — previously-active slot is untouched
// ---------------------------------------------------------------------------

describe('slot rotation', () => {
  it('prepare-inactive wipes only the inactive slot, not the active one', async () => {
    // First publish: write to the first inactive slot
    const { slot: slot1, slotDir: slotDir1 } = await prepareInactiveSlot(uploadsDir, SITE)
    await writeArtefact(slotDir1, '/post/foo', '<html>gen1</html>')
    await swapSlot(uploadsDir, SITE, slot1)
    // State: current → slot1, slot1 has content

    // Second publish: prepare inactive (the OTHER slot — NOT slot1)
    const { slot: slot2, slotDir: slotDir2 } = await prepareInactiveSlot(uploadsDir, SITE)
    // slot2 is the inactive one (opposite of slot1). Writing to slot2.
    await writeArtefact(slotDir2, '/post/foo', '<html>gen2</html>')
    await swapSlot(uploadsDir, SITE, slot2)
    // State: current → slot2, slot1 still has gen1 content

    // After the second publish:
    // - slot2 (now active) has gen2 content
    expect(await readArtefact(uploadsDir, SITE, '/post/foo')).toBe('<html>gen2</html>')

    // - slot1 (now inactive, was previously active) still has gen1 content
    //   because prepareInactiveSlot only wiped slot2 (which was inactive at
    //   the time), NOT slot1.
    const slot1Content = await readFile(join(slotDir1, 'post', 'foo.html'), 'utf-8')
    expect(slot1Content).toBe('<html>gen1</html>')
  })

  it('three-cycle rotation: each swap serves the right generation', async () => {
    const ROUTE = '/article/test'

    // Cycle 1
    const { slot: s1, slotDir: sd1 } = await prepareInactiveSlot(uploadsDir, SITE)
    await writeArtefact(sd1, ROUTE, '<html>gen1</html>')
    await swapSlot(uploadsDir, SITE, s1)
    expect(await readArtefact(uploadsDir, SITE, ROUTE)).toBe('<html>gen1</html>')

    // Cycle 2
    const { slot: s2, slotDir: sd2 } = await prepareInactiveSlot(uploadsDir, SITE)
    await writeArtefact(sd2, ROUTE, '<html>gen2</html>')
    await swapSlot(uploadsDir, SITE, s2)
    expect(await readArtefact(uploadsDir, SITE, ROUTE)).toBe('<html>gen2</html>')

    // Cycle 3 (wipes slot s1 since it is now inactive)
    const { slot: s3, slotDir: sd3 } = await prepareInactiveSlot(uploadsDir, SITE)
    expect(s3).toBe(s1) // must have cycled back
    await writeArtefact(sd3, ROUTE, '<html>gen3</html>')
    await swapSlot(uploadsDir, SITE, s3)
    expect(await readArtefact(uploadsDir, SITE, ROUTE)).toBe('<html>gen3</html>')

    // Slot s2 still has gen2 (was not wiped by cycle 3)
    const s2Content = await readFile(join(sd2, 'article', 'test.html'), 'utf-8')
    expect(s2Content).toBe('<html>gen2</html>')
  })
})

// ---------------------------------------------------------------------------
// Path-escape safety
// ---------------------------------------------------------------------------

describe('path safety', () => {
  describe('writeArtefact rejects unsafe paths', () => {
    it('rejects .. segments', async () => {
      const { slotDir } = await prepareInactiveSlot(uploadsDir, SITE)
      await expect(writeArtefact(slotDir, '/../etc/passwd', '<html>')).rejects.toThrow(
        '..',
      )
    })

    it('rejects URL-encoded .. segments (%2e%2e)', async () => {
      const { slotDir } = await prepareInactiveSlot(uploadsDir, SITE)
      await expect(writeArtefact(slotDir, '/%2e%2e/etc/passwd', '<html>')).rejects.toThrow(
        '..',
      )
    })

    it('rejects mixed-case URL-encoded .. (%2E%2E)', async () => {
      const { slotDir } = await prepareInactiveSlot(uploadsDir, SITE)
      await expect(writeArtefact(slotDir, '/%2E%2E/etc/passwd', '<html>')).rejects.toThrow(
        '..',
      )
    })

    it('rejects embedded absolute paths (double-slash)', async () => {
      const { slotDir } = await prepareInactiveSlot(uploadsDir, SITE)
      await expect(writeArtefact(slotDir, '//etc/passwd', '<html>')).rejects.toThrow()
    })

    it('rejects mid-path .. traversal', async () => {
      const { slotDir } = await prepareInactiveSlot(uploadsDir, SITE)
      await expect(writeArtefact(slotDir, '/a/b/../../../etc/passwd', '<html>')).rejects.toThrow(
        '..',
      )
    })
  })

  describe('readArtefact returns null for unsafe paths (never throws)', () => {
    it('returns null for .. path', async () => {
      const result = await readArtefact(uploadsDir, SITE, '/../etc/passwd')
      expect(result).toBeNull()
    })

    it('returns null for URL-encoded .. path', async () => {
      const result = await readArtefact(uploadsDir, SITE, '/%2e%2e/etc/passwd')
      expect(result).toBeNull()
    })

    it('returns null for embedded absolute path', async () => {
      const result = await readArtefact(uploadsDir, SITE, '//etc/passwd')
      expect(result).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// readArtefact — null returns
// ---------------------------------------------------------------------------

describe('readArtefact', () => {
  it('returns null when no current symlink exists (never published)', async () => {
    const result = await readArtefact(uploadsDir, SITE, '/about')
    expect(result).toBeNull()
  })

  it('returns null when file does not exist in active slot', async () => {
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir, SITE)
    await writeArtefact(slotDir, '/existing', '<html>exists</html>')
    await swapSlot(uploadsDir, SITE, slot)

    // Reading a different, unpublished route returns null
    const result = await readArtefact(uploadsDir, SITE, '/non-existent')
    expect(result).toBeNull()
  })

  it('does not throw for any non-existent path', async () => {
    // Should never throw; always return null
    const result1 = await readArtefact(uploadsDir, SITE, '/')
    const result2 = await readArtefact(uploadsDir, SITE, '/a/b/c/d/e')
    expect(result1).toBeNull()
    expect(result2).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// updateArtefactInPlace
// ---------------------------------------------------------------------------

describe('updateArtefactInPlace', () => {
  it('writes into the currently-active slot', async () => {
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir, SITE)
    await writeArtefact(slotDir, '/original', '<html>v1</html>')
    await swapSlot(uploadsDir, SITE, slot)

    await updateArtefactInPlace(uploadsDir, SITE, '/original', '<html>v2</html>')
    const result = await readArtefact(uploadsDir, SITE, '/original')
    expect(result).toBe('<html>v2</html>')
  })

  it('write is atomic: no .tmp file left on success', async () => {
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir, SITE)
    await writeArtefact(slotDir, '/page', '<html>v1</html>')
    await swapSlot(uploadsDir, SITE, slot)

    await updateArtefactInPlace(uploadsDir, SITE, '/page', '<html>v2</html>')

    let tmpExists = false
    try {
      await stat(join(slotDir, 'page.html.tmp'))
      tmpExists = true
    } catch {
      // expected
    }
    expect(tmpExists).toBe(false)
  })

  it('can write a new route that did not previously exist', async () => {
    const { slot } = await prepareInactiveSlot(uploadsDir, SITE)
    await swapSlot(uploadsDir, SITE, slot)

    // updateArtefactInPlace creates directories as needed
    await updateArtefactInPlace(uploadsDir, SITE, '/new/page', '<html>new</html>')
    const result = await readArtefact(uploadsDir, SITE, '/new/page')
    expect(result).toBe('<html>new</html>')
  })
})

// ---------------------------------------------------------------------------
// removeArtefactInPlace
// ---------------------------------------------------------------------------

describe('removeArtefactInPlace', () => {
  it('is a no-op when the file does not exist (never throws)', async () => {
    const { slot } = await prepareInactiveSlot(uploadsDir, SITE)
    await swapSlot(uploadsDir, SITE, slot)

    // Must not throw
    await removeArtefactInPlace(uploadsDir, SITE, '/non-existent')
  })

  it('is a no-op when the current symlink does not exist', async () => {
    // No symlink — getActiveSlot returns 'a', but the slot dir does not exist
    await removeArtefactInPlace(uploadsDir, SITE, '/anything')
    // Should not throw
  })

  it('removes an existing artefact from the active slot', async () => {
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir, SITE)
    await writeArtefact(slotDir, '/bye', '<html>bye</html>')
    await swapSlot(uploadsDir, SITE, slot)

    // Confirm it exists
    expect(await readArtefact(uploadsDir, SITE, '/bye')).toBe('<html>bye</html>')

    // Remove it
    await removeArtefactInPlace(uploadsDir, SITE, '/bye')

    // Confirm it's gone
    expect(await readArtefact(uploadsDir, SITE, '/bye')).toBeNull()
  })

  it('silently ignores unsafe paths', async () => {
    const { slot } = await prepareInactiveSlot(uploadsDir, SITE)
    await swapSlot(uploadsDir, SITE, slot)
    // Must not throw for a path that would escape the root
    await removeArtefactInPlace(uploadsDir, SITE, '/../etc/passwd')
  })
})

// ---------------------------------------------------------------------------
// prepareInactiveSlot
// ---------------------------------------------------------------------------

describe('prepareInactiveSlot', () => {
  it('returns slot "b" on the very first call (no symlink)', async () => {
    const { slot } = await prepareInactiveSlot(uploadsDir, SITE)
    expect(slot).toBe('b')
  })

  it('wipes stale files from the previous generation in the inactive slot', async () => {
    // Publish cycle 1: slot b is the target
    const { slot: s1, slotDir: sd1 } = await prepareInactiveSlot(uploadsDir, SITE)
    expect(s1).toBe('b')
    await writeArtefact(sd1, '/stale', '<html>stale</html>')
    await swapSlot(uploadsDir, SITE, s1)
    // current → b, b has 'stale'

    // Publish cycle 2: slot a is inactive (current = b → inactive = a)
    const { slot: s2 } = await prepareInactiveSlot(uploadsDir, SITE)
    expect(s2).toBe('a')
    await swapSlot(uploadsDir, SITE, s2)
    // current → a, b is now inactive (still has stale content)

    // Publish cycle 3: slot b is inactive again — prepareInactiveSlot wipes it
    const { slot: s3, slotDir: sd3 } = await prepareInactiveSlot(uploadsDir, SITE)
    expect(s3).toBe('b')

    // The stale file should no longer exist in the wiped slot
    let staleExists = false
    try {
      await stat(join(sd3, 'stale.html'))
      staleExists = true
    } catch {
      // expected: wiped
    }
    expect(staleExists).toBe(false)
  })

  it('creates the published/ directory if it does not exist', async () => {
    // uploadsDir exists but published/ does not
    await prepareInactiveSlot(uploadsDir, SITE)
    const publishedStat = await stat(join(uploadsDir, 'published'))
    expect(publishedStat.isDirectory()).toBe(true)
  })
})
