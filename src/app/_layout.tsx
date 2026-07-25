import '@/lib/polyfills';

import * as Notifications from 'expo-notifications';
import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { LockProvider } from '@/components/lock-screen';
import { PopupProvider } from '@/components/popup';
import { colors } from '@/lib/theme';
import { WalletProvider } from '@/lib/wallet-context';

// Route a tapped push notification to the right screen. 'request' deep-links
// into Send prefilled with who's asking and how much (send.tsx marks the
// request paid once the payment lands); everything else (e.g. 'received')
// just opens the app to Home, which is already the default landing screen.
function useNotificationRouting() {
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown>;
      if (data?.type === 'request' && typeof data.requestId === 'string') {
        router.push({
          pathname: '/send',
          params: {
            to: data.from,
            toName: data.fromName,
            amount: data.amount,
            requestId: data.requestId,
          },
        } as any);
      }
    });
    return () => sub.remove();
  }, []);
}

// iOS keeps the native sheet transition (with the card-stack depth effect);
// Android gets an equivalent slide-up, which it lacks by default.
const MODAL = {
  presentation: 'modal',
  animation: Platform.OS === 'android' ? 'slide_from_bottom' : 'default',
} as const;

export default function RootLayout() {
  useNotificationRouting();
  return (
    <WalletProvider>
      <LockProvider>
      <PopupProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
            // The standard pattern: pushes slide in from the right,
            // modals (below) slide up from the bottom.
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen name="index" options={{ animation: 'fade' }} />
          <Stack.Screen name="invite" options={{ animation: 'fade' }} />
          <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
          <Stack.Screen name="recover" />
          <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
          <Stack.Screen name="send" options={MODAL} />
          <Stack.Screen name="request" options={MODAL} />
          <Stack.Screen name="scan" options={MODAL} />
          <Stack.Screen name="add-cash" options={MODAL} />
          <Stack.Screen name="cash-in-wallet" />
          <Stack.Screen name="cash-out" options={MODAL} />
          <Stack.Screen name="earn-add" options={MODAL} />
          <Stack.Screen name="earn-withdraw" options={MODAL} />
          <Stack.Screen name="simulate" />
          <Stack.Screen name="edit-profile" options={MODAL} />
          <Stack.Screen name="verify-email" options={MODAL} />
          <Stack.Screen name="notifications" />
          <Stack.Screen name="tx-detail" options={MODAL} />
        </Stack>
      </PopupProvider>
      </LockProvider>
    </WalletProvider>
  );
}
