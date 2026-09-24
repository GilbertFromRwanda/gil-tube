import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { getApiBaseUrl, setApiBaseUrl } from '../api/client';
import { canChooseFolder, chooseSaveFolder, forgetSaveFolder, getSaveFolderLabel, SaveCancelledError } from '../storage/saveLocation';
import { useTheme } from '../theme/theme';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export function SettingsScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [folderError, setFolderError] = useState('');

  // Reload from storage whenever this screen gains focus, so returning from
  // a successful QR scan (which writes straight to storage) shows up here.
  useFocusEffect(
    useCallback(() => {
      getApiBaseUrl().then((stored) => setValue(stored || ''));
      getSaveFolderLabel().then(setFolder);
    }, []),
  );

  const onChooseFolder = async () => {
    setFolderError('');
    try {
      await chooseSaveFolder();
      setFolder(await getSaveFolderLabel());
    } catch (err) {
      if (!(err instanceof SaveCancelledError)) {
        setFolderError(err instanceof Error ? err.message : 'Could not use that folder.');
      }
    }
  };

  const onResetFolder = async () => {
    await forgetSaveFolder();
    setFolder(await getSaveFolderLabel());
  };

  const onSave = async () => {
    await setApiBaseUrl(value);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Text style={[styles.label, { color: colors.text }]}>API server address</Text>
      <Text style={[styles.hint, { color: colors.muted }]}>
        The Gil Tube API is not reachable at "localhost" from a phone. Point this at the
        machine running docker compose, e.g. http://192.168.1.20:8081. Android emulators can
        use http://10.0.2.2:8081; the iOS simulator can use http://localhost:8081.
      </Text>

      <Pressable
        onPress={() => navigation.navigate('ScanQr')}
        style={[styles.scanButton, { borderColor: colors.primary }]}
      >
        <Text style={{ color: colors.primary, fontWeight: '700' }}>📷 Scan QR from web UI</Text>
      </Pressable>

      <Text style={[styles.orLabel, { color: colors.muted }]}>or type it manually</Text>

      <TextInput
        value={value}
        onChangeText={setValue}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="http://192.168.1.20:8081"
        placeholderTextColor={colors.muted}
        style={[styles.input, { backgroundColor: colors.panelAlt, borderColor: colors.border, color: colors.text }]}
      />
      <Pressable onPress={onSave} style={[styles.saveButton, { backgroundColor: colors.primary }]}>
        <Text style={styles.saveButtonText}>{saved ? 'Saved' : 'Save'}</Text>
      </Pressable>

      <Text style={[styles.label, styles.sectionGap, { color: colors.text }]}>Save location</Text>
      <Text style={[styles.hint, { color: colors.muted }]}>
        {canChooseFolder
          ? 'Downloaded videos are saved to your Downloads folder. You choose the folder once and it is remembered.'
          : 'Downloaded videos are saved automatically in the Gil Tube folder in the Files app.'}
      </Text>
      <View style={[styles.folderBox, { backgroundColor: colors.panelAlt, borderColor: colors.border }]}>
        <Text style={{ color: folder ? colors.text : colors.muted }} numberOfLines={2}>
          {folder ?? 'Not chosen yet - you will be asked when you save your first video'}
        </Text>
      </View>
      {canChooseFolder ? (
        <View style={styles.folderActions}>
          <Pressable onPress={onChooseFolder}>
            <Text style={{ color: colors.primary, fontWeight: '600' }}>{folder ? 'Change folder' : 'Choose folder'}</Text>
          </Pressable>
          {folder ? (
            <Pressable onPress={onResetFolder}>
              <Text style={{ color: colors.muted, fontWeight: '600' }}>Forget</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {folderError ? <Text style={[styles.hint, { color: colors.danger }]}>{folderError}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, paddingTop: 54 },
  label: { fontSize: 15, fontWeight: '700' },
  hint: { fontSize: 12, marginTop: 8, lineHeight: 17 },
  scanButton: {
    marginTop: 20,
    borderWidth: 1.5,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  orLabel: { textAlign: 'center', fontSize: 12, marginTop: 14, marginBottom: 4 },
  input: { marginTop: 10, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, height: 42 },
  saveButton: { marginTop: 16, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  saveButtonText: { color: '#04121f', fontWeight: '700' },
  sectionGap: { marginTop: 32 },
  folderBox: { marginTop: 12, borderWidth: 1, borderRadius: 10, padding: 12 },
  folderActions: { flexDirection: 'row', gap: 20, marginTop: 12 },
});
