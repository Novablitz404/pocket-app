import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/button';
import { usePopup } from '@/components/popup';
import { normalizeUsername } from '@/lib/directory';
import { colors, radius } from '@/lib/theme';
import { USERNAME_CHANGE_COOLDOWN_MS, useWallet } from '@/lib/wallet-context';

export default function EditProfile() {
  const wallet = useWallet();
  const popup = usePopup();
  const [first, setFirst] = useState(wallet.firstName ?? '');
  const [last, setLast] = useState(wallet.lastName ?? '');
  const [handle, setHandle] = useState(wallet.username ?? '');
  const [saving, setSaving] = useState(false);

  const cooldownUntil = wallet.usernameChangedAt
    ? wallet.usernameChangedAt + USERNAME_CHANGE_COOLDOWN_MS
    : null;
  const usernameLocked = cooldownUntil !== null && cooldownUntil > Date.now();

  const nameDirty = first.trim() !== (wallet.firstName ?? '') || last.trim() !== (wallet.lastName ?? '');
  const usernameDirty = handle !== (wallet.username ?? '');
  const ready =
    (nameDirty || usernameDirty) &&
    first.trim().length >= 1 &&
    last.trim().length >= 1 &&
    handle.trim().length >= 2;

  const save = async () => {
    if (usernameDirty) {
      const ok = await popup.confirm({
        title: 'Change username?',
        message: `Your username becomes @${handle}. You can only change it once a month.`,
        confirmText: 'Change username',
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      // Username first: it can fail (taken / cooldown) and nothing else
      // should have been saved yet when it does.
      if (usernameDirty) await wallet.changeUsername(handle);
      if (nameDirty) await wallet.updateName(first.trim(), last.trim());
      router.back();
    } catch (e: any) {
      popup.alert({ title: 'Could not save', message: e?.message ?? 'Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <Text style={styles.title}>Edit profile</Text>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Ionicons name="close" size={26} color={colors.ink} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ gap: 12, paddingTop: 20 }} keyboardShouldPersistTaps="handled">
          <Text style={styles.label}>Name</Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="First name"
              placeholderTextColor={colors.sub}
              value={first}
              onChangeText={setFirst}
              autoCapitalize="words"
            />
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="Last name"
              placeholderTextColor={colors.sub}
              value={last}
              onChangeText={setLast}
              autoCapitalize="words"
            />
          </View>

          <Text style={styles.label}>Username</Text>
          <TextInput
            style={[styles.input, usernameLocked && styles.inputDisabled]}
            placeholder="Username"
            placeholderTextColor={colors.sub}
            value={handle}
            onChangeText={(t) => setHandle(normalizeUsername(t))}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!usernameLocked}
          />
          <Text style={styles.hint}>
            {usernameLocked
              ? `You changed your username recently. You can change it again on ${new Date(cooldownUntil).toLocaleDateString()}.`
              : 'You can change your username once a month.'}
          </Text>
        </ScrollView>

        <Button title="Save" onPress={save} loading={saving} disabled={!ready} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 20 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '800', color: colors.ink },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.sub,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 8,
  },
  row: { flexDirection: 'row', gap: 12 },
  input: {
    height: 56,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 18,
    fontSize: 17,
    color: colors.ink,
  },
  inputDisabled: { opacity: 0.5 },
  hint: { fontSize: 13, color: colors.sub, lineHeight: 18 },
});
