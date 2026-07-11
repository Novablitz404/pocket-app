import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/button';
import { colors } from '@/lib/theme';

// Payload format: remitt:G...?amount=12.50&name=Eric
function parsePayload(data: string): { to: string; amount?: string; name?: string } | null {
  const match = data.match(/^remitt:([A-Z0-9]{56})(?:\?(.*))?$/);
  if (!match) {
    // Plain Stellar address QR
    return /^G[A-Z0-9]{55}$/.test(data) ? { to: data } : null;
  }
  const params = new URLSearchParams(match[2] ?? '');
  return {
    to: match[1],
    amount: params.get('amount') ?? undefined,
    name: params.get('name') ?? undefined,
  };
}

export default function Scan() {
  const { amount: presetAmount } = useLocalSearchParams<{ amount?: string }>();
  const [permission, requestPermission] = useCameraPermissions();
  const scanned = useRef(false);

  const onScanned = ({ data }: { data: string }) => {
    if (scanned.current) return;
    const parsed = parsePayload(data);
    if (!parsed) return;
    scanned.current = true;
    router.replace({
      pathname: '/send',
      params: {
        to: parsed.to,
        amount: parsed.amount ?? presetAmount ?? '',
        toName: parsed.name ?? '',
      },
    } as any);
  };

  if (!permission?.granted) {
    return (
      <SafeAreaView style={styles.permission}>
        <Text style={styles.permissionText}>
          Remitt needs camera access to scan payment codes.
        </Text>
        <Button title="Allow camera" onPress={requestPermission} />
      </SafeAreaView>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={onScanned}
      />
      <SafeAreaView style={styles.overlay}>
        <View style={styles.topBar}>
          <Text style={styles.hint}>Scan a Remitt code</Text>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Ionicons name="close" size={28} color="#fff" />
          </Pressable>
        </View>
        <View style={styles.frame} />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  permission: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    padding: 24,
    gap: 20,
  },
  permissionText: { fontSize: 17, color: colors.ink, textAlign: 'center' },
  overlay: { flex: 1, padding: 20 },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hint: { color: '#fff', fontSize: 17, fontWeight: '700' },
  frame: {
    alignSelf: 'center',
    marginTop: 120,
    width: 260,
    height: 260,
    borderRadius: 24,
    borderWidth: 3,
    borderColor: '#fff',
  },
});
