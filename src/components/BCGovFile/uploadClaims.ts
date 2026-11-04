/**
 * Cross-tab claims on stored files, so only one tab or window uploads a given file. Stored files
 * are shared by every tab on the origin, and each tab retries the ones on its form, so without a
 * claim two tabs open on the same submission would both upload the file.
 *
 * Uses the Web Locks API, which the browser releases when the tab closes or crashes. Where it is
 * missing (older browsers, or a page not served over HTTPS), a lease in localStorage stands in; it
 * is renewed while held and simply expires if the tab dies.
 */

/** Releases a claim. Safe to call more than once. */
export type ReleaseClaim = () => void;

const LOCK_PREFIX = 'bcgov-formio-offline-upload:';
const LEASE_PREFIX = 'bcgov-formio-offline-claim:';
const LEASE_MS = 60000;
const LEASE_RENEW_MS = 20000;

// Identifies this tab's leases
const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const webLocks = (): any => {
  const locks = typeof navigator !== 'undefined' ? (navigator as any).locks : undefined;
  return typeof locks?.request === 'function' ? locks : null;
};

const leaseStorage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch (e) {
    return null;
  }
};

const readLease = (storage: Storage, key: string): { owner: string; until: number } | null => {
  try {
    const lease = JSON.parse(storage.getItem(LEASE_PREFIX + key) || 'null');
    return lease && typeof lease.owner === 'string' && typeof lease.until === 'number' ? lease : null;
  } catch (e) {
    return null;
  }
};

const heldByAnotherTab = (lease: { owner: string; until: number } | null) =>
  !!lease && lease.owner !== tabId && lease.until > Date.now();

const claimWithLock = (locks: any, key: string): Promise<ReleaseClaim | null> =>
  new Promise((resolve, reject) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    locks
      .request(LOCK_PREFIX + key, { ifAvailable: true }, (lock: any) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        resolve(release);
        // The lock is held until this promise settles
        return held;
      })
      .catch(reject);
  });

const claimWithLease = (key: string): ReleaseClaim | null => {
  const storage = leaseStorage();
  if (!storage) {
    // Nowhere to record a claim; behave as before rather than never uploading
    return () => undefined;
  }
  if (heldByAnotherTab(readLease(storage, key))) {
    return null;
  }
  const write = () => {
    try {
      storage.setItem(LEASE_PREFIX + key, JSON.stringify({ owner: tabId, until: Date.now() + LEASE_MS }));
    } catch (e) {
      // Quota or blocked storage; the claim then expires early at worst
    }
  };
  write();
  // Another tab may have written between our read and write; whoever's write landed last wins
  if (readLease(storage, key)?.owner !== tabId) {
    return null;
  }
  const renew = setInterval(write, LEASE_RENEW_MS);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    clearInterval(renew);
    if (readLease(storage, key)?.owner === tabId) {
      storage.removeItem(LEASE_PREFIX + key);
    }
  };
};

/**
 * Claim a stored file for upload. Resolves a release function, or null when another tab or window
 * holds the claim (it is uploading the file right now).
 */
export async function claimOfflineFile(key: string): Promise<ReleaseClaim | null> {
  const locks = webLocks();
  if (locks) {
    try {
      return await claimWithLock(locks, key);
    } catch (e) {
      // e.g. SecurityError in an opaque origin; use the lease instead
    }
  }
  return claimWithLease(key);
}

/** Whether another tab or window is uploading the stored file right now. */
export async function isOfflineFileClaimed(key: string): Promise<boolean> {
  const locks = webLocks();
  if (locks && typeof locks.query === 'function') {
    try {
      const { held = [] } = await locks.query();
      if (held.some((lock: any) => lock.name === LOCK_PREFIX + key)) {
        return true;
      }
    } catch (e) {
      // fall through to the lease check
    }
  }
  const storage = leaseStorage();
  return !!storage && heldByAnotherTab(readLease(storage, key));
}
