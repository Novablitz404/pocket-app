// Profile picture pipeline: pick from the photo library (square-cropped),
// shrink to 256px JPEG (~20-40 KB, loads fast in lists), and upload to the
// Supabase 'avatars' storage bucket. The bucket must be public; the stored
// avatar_url carries a ?v= cache buster so a re-upload to the same path
// (one file per address) shows up immediately.
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { ANON_KEY, directoryEnabled, SUPABASE_URL } from './directory';

const BUCKET = 'avatars';
const SIZE = 256;
const JPEG_QUALITY = 0.7;

/**
 * Open the photo library (square crop) and return the picked image's local
 * URI, or null when cancelled. Used standalone by onboarding, where the
 * wallet address — and therefore the upload path — doesn't exist yet.
 */
export async function pickAvatarImage(): Promise<string | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Allow photo access in your device settings to set a profile picture.');
  }

  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1, // full quality here; the resize in uploadAvatar does the compression
  });
  return picked.canceled ? null : picked.assets[0].uri;
}

/** Compress a local image and upload it as this address's profile picture. */
export async function uploadAvatar(address: string, localUri: string): Promise<string> {
  if (!directoryEnabled) {
    throw new Error('Profile photos need the directory configured (Supabase env vars).');
  }

  const context = ImageManipulator.manipulate(localUri);
  context.resize({ width: SIZE, height: SIZE });
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });

  // RN's fetch can read a local file:// URI into a blob for the upload body.
  const blob = await (await fetch(saved.uri)).blob();
  const path = `${address}.jpg`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      'Content-Type': 'image/jpeg',
      'x-upsert': 'true',
    },
    body: blob,
  });
  if (!res.ok) {
    // Surface Supabase's reason (e.g. a missing storage RLS policy) — a
    // generic "try again" hides a config problem that retrying won't fix.
    const detail = await res.text().catch(() => '');
    throw new Error(`Could not upload the photo (HTTP ${res.status}). ${detail.slice(0, 200)}`);
  }

  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}?v=${Date.now()}`;
}

/**
 * Pick, compress, and upload in one step (Settings' change-photo flow).
 * Resolves with the public URL, or null when the user cancelled the picker.
 */
export async function pickAndUploadAvatar(address: string): Promise<string | null> {
  const localUri = await pickAvatarImage();
  if (!localUri) return null;
  return uploadAvatar(address, localUri);
}
