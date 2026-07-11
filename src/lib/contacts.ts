// Contacts, stored on-device (AsyncStorage) — not in Supabase. A contact is
// any Stellar account this wallet has exchanged a P2P payment with. Soroban
// contracts (Earn/Blend, C... addresses) and the treasury's cash-in/out rails
// never become contacts; wallet-context filters to 'sent'/'received' activity
// before merging. Names/avatars are resolved from the directory at render.
import AsyncStorage from '@react-native-async-storage/async-storage';

export const CONTACTS_KEY = 'remitt.contacts';

export interface Contact {
  address: string;
  /** ISO timestamp of the most recent payment with this account. */
  lastAt: string;
  /** Pinned by the user; favorites surface in the Send sheet. */
  favorite?: boolean;
}

function sorted(contacts: Contact[]): Contact[] {
  return [...contacts].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

export async function getContacts(): Promise<Contact[]> {
  try {
    const raw = await AsyncStorage.getItem(CONTACTS_KEY);
    return raw ? sorted(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** Merge newly seen counterparties in, keeping the most recent timestamp
 *  per address. `exclude` (the wallet's own address) is dropped and purged
 *  from anything already stored. Returns the full list, most recent first. */
export async function mergeContacts(entries: Contact[], exclude?: string): Promise<Contact[]> {
  const byAddress = new Map<string, Contact>();
  for (const c of await getContacts()) byAddress.set(c.address, c);
  for (const e of entries) {
    const existing = byAddress.get(e.address);
    if (!existing || existing.lastAt < e.lastAt) {
      byAddress.set(e.address, { ...e, favorite: existing?.favorite ?? e.favorite });
    }
  }
  if (exclude) byAddress.delete(exclude);
  const merged = sorted([...byAddress.values()]);
  try {
    await AsyncStorage.setItem(CONTACTS_KEY, JSON.stringify(merged));
  } catch {
    // Best-effort persistence; the in-memory list still works this session.
  }
  return merged;
}

/** Toggle an address's favorite flag. Returns the updated list. */
export async function toggleFavorite(address: string): Promise<Contact[]> {
  const contacts = (await getContacts()).map((c) =>
    c.address === address ? { ...c, favorite: !c.favorite } : c,
  );
  try {
    await AsyncStorage.setItem(CONTACTS_KEY, JSON.stringify(contacts));
  } catch {
    // Best-effort persistence.
  }
  return contacts;
}
