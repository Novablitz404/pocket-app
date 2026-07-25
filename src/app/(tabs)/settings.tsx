import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/avatar';
import { OptionPicker } from '@/components/option-picker';
import { usePopup } from '@/components/popup';
import { changePasscode } from '@/lib/biometrics';
import { colors, formatUsd, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

// Preference lists, not exhaustive: the main PH remittance corridors for now.
const COUNTRIES = [
  { value: 'PH', label: 'Philippines' },
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
  { value: 'AE', label: 'United Arab Emirates' },
  { value: 'SA', label: 'Saudi Arabia' },
  { value: 'QA', label: 'Qatar' },
  { value: 'KW', label: 'Kuwait' },
  { value: 'SG', label: 'Singapore' },
  { value: 'HK', label: 'Hong Kong' },
  { value: 'JP', label: 'Japan' },
  { value: 'AU', label: 'Australia' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'IT', label: 'Italy' },
];

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'fil', label: 'Filipino' },
];

function Row({
  icon,
  label,
  value,
  onPress,
  destructive,
  loading,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value?: string;
  onPress?: () => void;
  destructive?: boolean;
  loading?: boolean;
}) {
  const tint = destructive ? colors.danger : colors.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress || loading}
      style={({ pressed }) => [styles.row, pressed && onPress && { opacity: 0.6 }]}
    >
      <View style={[styles.rowIcon, destructive && { backgroundColor: '#FBEAEA' }]}>
        <Ionicons name={icon} size={18} color={destructive ? colors.danger : colors.accentDark} />
      </View>
      <Text style={[styles.rowLabel, { color: tint }]}>{label}</Text>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      {onPress ? <Ionicons name="chevron-forward" size={16} color={colors.sub} /> : null}
    </Pressable>
  );
}

export default function Settings() {
  const { name, username, email, emailVerified, country, language, avatarUrl, accountVerified, balance, activated, setCountry, setLanguage, changeAvatar, closeAccount, reset } =
    useWallet();
  const popup = usePopup();
  const insets = useSafeAreaInsets();
  const [closing, setClosing] = useState(false);
  const [picker, setPicker] = useState<'country' | 'language' | null>(null);

  const countryLabel = COUNTRIES.find((c) => c.value === country)?.label ?? country ?? 'Not set';
  const languageLabel = LANGUAGES.find((l) => l.value === language)?.label ?? 'English';

  const onChangePasscode = async () => {
    if (await changePasscode()) {
      popup.alert({ title: 'Passcode changed', message: 'Your new passcode is now active.' });
    }
  };

  const [uploading, setUploading] = useState(false);
  const onChangeAvatar = async () => {
    setUploading(true);
    try {
      await changeAvatar();
    } catch (e: any) {
      popup.alert({ title: 'Could not update photo', message: e?.message ?? 'Please try again.' });
    } finally {
      setUploading(false);
    }
  };

  const onCloseAccount = async () => {
    const ok = await popup.confirm({
      title: 'Close account?',
      message: activated
        ? `Your ${formatUsd(balance)} balance is returned to you and the account is closed on the network. Remitt reclaims the reserve it fronted.`
        : 'This closes your account and returns to sign-up.',
      confirmText: 'Close account',
      destructive: true,
    });
    if (!ok) return;
    setClosing(true);
    try {
      await closeAccount();
      router.replace('/onboarding');
    } catch (e: any) {
      popup.alert({ title: 'Could not close account', message: e?.message ?? 'Please try again.' });
    } finally {
      setClosing(false);
    }
  };

  const onReset = async () => {
    const ok = await popup.confirm({
      title: 'Reset this device?',
      message:
        'Removes the wallet from this device without closing the account on the network. Demo only — funds on the old key stay where they are.',
      confirmText: 'Reset',
      destructive: true,
    });
    if (!ok) return;
    await reset();
    router.replace('/onboarding');
  };

  return (
    <View style={[styles.safe, { paddingTop: insets.top }]}>
      <Text style={styles.title}>Settings</Text>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.profileCard}>
          <Pressable
            onPress={onChangeAvatar}
            disabled={uploading}
            style={({ pressed }) => [pressed && { opacity: 0.7 }, uploading && { opacity: 0.5 }]}
          >
            <Avatar name={name ?? ''} uri={avatarUrl} size={64} verified={accountVerified} />
            <View style={styles.avatarBadge}>
              <Ionicons name="camera" size={12} color="#fff" />
            </View>
          </Pressable>
          <Text style={styles.profileName}>{name ?? 'Welcome'}</Text>
          {username ? <Text style={styles.profileUsername}>@{username}</Text> : null}
        </View>

        <Text style={styles.sectionTitle}>Profile</Text>
        <View style={styles.card}>
          <Row icon="person-outline" label="Edit profile" onPress={() => router.push('/edit-profile')} />
          {email ? (
            <>
              <View style={styles.divider} />
              <Row icon="mail-outline" label="Email" value={email} />
              {!emailVerified && (
                <>
                  <View style={styles.divider} />
                  <Row
                    icon="shield-checkmark-outline"
                    label="Verify email"
                    value="Not verified"
                    onPress={() => router.push('/verify-email')}
                  />
                </>
              )}
            </>
          ) : null}
        </View>

        <Text style={styles.sectionTitle}>Preferences</Text>
        <View style={styles.card}>
          <Row icon="flag-outline" label="Country" value={countryLabel} onPress={() => setPicker('country')} />
          <View style={styles.divider} />
          <Row icon="language-outline" label="Language" value={languageLabel} onPress={() => setPicker('language')} />
        </View>

        <Text style={styles.sectionTitle}>Security</Text>
        <View style={styles.card}>
          <Row icon="keypad-outline" label="Change passcode" onPress={onChangePasscode} />
        </View>

        <Text style={styles.sectionTitle}>Account</Text>
        <View style={styles.card}>
          <Row
            icon="pulse-outline"
            label="Status"
            value={activated ? 'Active' : 'Awaiting first deposit'}
          />
          <View style={styles.divider} />
          <Row icon="globe-outline" label="Network" value="Stellar Testnet" />
        </View>

        <Text style={styles.sectionTitle}>Danger zone</Text>
        <View style={styles.card}>
          <Row
            icon="log-out-outline"
            label={closing ? 'Closing account…' : 'Close account & transfer'}
            onPress={onCloseAccount}
            destructive
            loading={closing}
          />
          <View style={styles.divider} />
          <Row icon="refresh-outline" label="Reset this device (demo)" onPress={onReset} destructive />
        </View>

        <Text style={styles.footer}>Remitt · USDC on Stellar</Text>
      </ScrollView>

      <OptionPicker
        visible={picker === 'country'}
        title="Country"
        options={COUNTRIES}
        selected={country}
        onSelect={(code) => setCountry(code).catch(() => {})}
        onClose={() => setPicker(null)}
      />
      <OptionPicker
        visible={picker === 'language'}
        title="Language"
        options={LANGUAGES}
        selected={language ?? 'en'}
        onSelect={(lang) => setLanguage(lang).catch(() => {})}
        onClose={() => setPicker(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  title: { fontSize: 28, fontWeight: '800', color: colors.ink, padding: 20, paddingBottom: 8 },
  container: { padding: 20, paddingTop: 0, paddingBottom: 40 },
  profileCard: { alignItems: 'center', paddingVertical: 20 },
  avatarBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.accentDark,
    borderWidth: 2,
    borderColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileName: { fontSize: 22, fontWeight: '800', color: colors.ink, marginTop: 12 },
  profileUsername: { fontSize: 15, color: colors.sub, marginTop: 4 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.sub,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 20,
    marginBottom: 8,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12 },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLabel: { fontSize: 15, fontWeight: '600', flex: 1 },
  rowValue: { fontSize: 14, color: colors.sub, fontWeight: '600' },
  divider: { height: 1, backgroundColor: colors.border, marginLeft: 44 },
  footer: { textAlign: 'center', color: colors.sub, fontSize: 13, marginTop: 28 },
});
