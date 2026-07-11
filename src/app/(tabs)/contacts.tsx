import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/avatar';
import type { Contact } from '@/lib/contacts';
import { colors } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

function shortId(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function ContactRow({ contact }: { contact: Contact }) {
  const { nameFor, profileFor, toggleFavorite } = useWallet();
  const profile = profileFor(contact.address);
  const displayName = nameFor(contact.address) ?? shortId(contact.address);

  const onPress = () =>
    router.push({
      pathname: '/send',
      params: { to: contact.address, toName: displayName },
    } as any);

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}>
      <Avatar name={displayName} uri={profile?.avatarUrl} size={44} />
      <View style={{ flex: 1 }}>
        <Text style={styles.name}>{displayName}</Text>
        <Text style={styles.sub}>{profile ? `@${profile.username}` : shortId(contact.address)}</Text>
      </View>
      <Pressable onPress={() => toggleFavorite(contact.address)} hitSlop={10}>
        <Ionicons
          name={contact.favorite ? 'star' : 'star-outline'}
          size={22}
          color={contact.favorite ? colors.gold : colors.sub}
        />
      </Pressable>
    </Pressable>
  );
}

export default function Contacts() {
  const { contacts, refresh } = useWallet();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  return (
    <View style={[styles.safe, { paddingTop: insets.top }]}>
      <Text style={styles.title}>Contacts</Text>
      <FlatList
        data={contacts}
        keyExtractor={(item) => item.address}
        renderItem={({ item }) => <ContactRow contact={item} />}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <View style={{ paddingTop: 60, alignItems: 'center' }}>
            <Text style={styles.empty}>People you send to or receive from show up here.</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  title: { fontSize: 28, fontWeight: '800', color: colors.ink, padding: 20, paddingBottom: 8 },
  list: { paddingHorizontal: 20, paddingBottom: 40 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 },
  name: { fontSize: 16, fontWeight: '600', color: colors.ink },
  sub: { fontSize: 13, color: colors.sub, marginTop: 2 },
  empty: { color: colors.sub, fontSize: 15, textAlign: 'center', paddingHorizontal: 30 },
});
