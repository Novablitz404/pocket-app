import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { Button } from '@/components/button';
import { colors, radius } from '@/lib/theme';

// Global popup modal, themed to the app (unlike the OS Alert). Mount
// <PopupProvider> once at the root, then from any screen:
//
//   const popup = usePopup();
//   const ok = await popup.confirm({
//     title: 'Withdraw?',
//     rows: [{ label: 'Fee', value: '$0.25' }],
//   });                                   // resolves true/false
//   await popup.alert({ title: 'Done!' }); // single-button variant

export interface PopupRow {
  label: string;
  value: string;
  /** Highlight this row (e.g. the bottom-line amount). */
  emphasize?: boolean;
}

export interface PopupOptions {
  title: string;
  message?: string;
  /** Label/value breakdown lines shown between message and buttons. */
  rows?: PopupRow[];
  confirmText?: string;
  cancelText?: string;
  /** Style the confirm button red for irreversible actions. */
  destructive?: boolean;
}

interface PopupState extends PopupOptions {
  showCancel: boolean;
}

interface PopupApi {
  /** Two buttons; resolves true when confirmed, false when cancelled. */
  confirm: (options: PopupOptions) => Promise<boolean>;
  /** One button; resolves when dismissed. */
  alert: (options: PopupOptions) => Promise<void>;
}

const PopupContext = createContext<PopupApi | null>(null);

export function PopupProvider({ children }: { children: React.ReactNode }) {
  const [popup, setPopup] = useState<PopupState | null>(null);
  const resolveRef = useRef<(ok: boolean) => void>(() => {});

  const open = useCallback((options: PopupOptions, showCancel: boolean) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setPopup({ ...options, showCancel });
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    setPopup(null);
    resolveRef.current(ok);
  }, []);

  const api = useRef<PopupApi>({
    confirm: (options) => open(options, true),
    alert: async (options) => {
      await open(options, false);
    },
  });

  const card = popup && (
    <Pressable style={styles.backdrop} onPress={() => popup.showCancel && close(false)}>
      <Pressable style={styles.card} onPress={() => {}}>
        <Text style={styles.title}>{popup.title}</Text>
        {popup.message ? <Text style={styles.message}>{popup.message}</Text> : null}
        {popup.rows && popup.rows.length > 0 && (
          <View style={styles.rows}>
            {popup.rows.map((row, i) => (
              <View key={row.label} style={[styles.row, i > 0 && styles.rowBorder]}>
                <Text style={[styles.rowLabel, row.emphasize && styles.rowEmphasis]}>
                  {row.label}
                </Text>
                <Text style={[styles.rowValue, row.emphasize && styles.rowEmphasis]}>
                  {row.value}
                </Text>
              </View>
            ))}
          </View>
        )}
        <Button
          title={popup.confirmText ?? (popup.showCancel ? 'Confirm' : 'OK')}
          onPress={() => close(true)}
          style={{ marginTop: 20, ...(popup.destructive ? { backgroundColor: colors.danger } : {}) }}
        />
        {popup.showCancel && (
          <Button
            title={popup.cancelText ?? 'Cancel'}
            variant="ghost"
            onPress={() => close(false)}
            style={{ marginTop: 6 }}
          />
        )}
      </Pressable>
    </Pressable>
  );

  return (
    <PopupContext.Provider value={api.current}>
      {children}
      {/* iOS: react-native's Modal cannot present while a native sheet
          (expo-router presentation:'modal') is up — it silently fails, the
          popup never shows, and its invisible window blocks all touches.
          FullWindowOverlay renders into a window above ALL native modals.
          Android: a plain Modal (Dialog) already floats above everything. */}
      {Platform.OS === 'ios'
        ? popup && (
            <FullWindowOverlay>
              <View style={StyleSheet.absoluteFill}>{card}</View>
            </FullWindowOverlay>
          )
        : (
            <Modal
              visible={popup !== null}
              transparent
              animationType="fade"
              onRequestClose={() => close(false)}
            >
              {card}
            </Modal>
          )}
    </PopupContext.Provider>
  );
}

export function usePopup(): PopupApi {
  const ctx = useContext(PopupContext);
  if (!ctx) throw new Error('usePopup must be used within PopupProvider');
  return ctx;
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,24,22,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  card: {
    alignSelf: 'stretch',
    backgroundColor: colors.bg,
    borderRadius: radius.lg,
    padding: 24,
  },
  title: { fontSize: 20, fontWeight: '800', color: colors.ink, textAlign: 'center' },
  message: {
    fontSize: 15,
    color: colors.sub,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 21,
  },
  rows: {
    marginTop: 16,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
  },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  rowLabel: { fontSize: 14, color: colors.sub, fontWeight: '600' },
  rowValue: { fontSize: 14, color: colors.ink, fontWeight: '700' },
  rowEmphasis: { color: colors.accentDark, fontSize: 15, fontWeight: '800' },
});
