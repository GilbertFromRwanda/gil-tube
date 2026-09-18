import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { setApiBaseUrl } from '../api/client';
import { useTheme } from '../theme/theme';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'ScanQr'>;

// The web UI's "Connect the mobile app" dialog encodes its API address
// (e.g. http://192.168.1.20:8081) as a QR code - scanning it here saves
// the user from typing a LAN IP by hand.
export function ScanQrScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState('');

  const onScanned = ({ data }: { data: string }) => {
    if (scanned) return;
    const text = data.trim();
    if (!/^https?:\/\/\S+$/i.test(text)) {
      setError('That QR code is not a Gil Tube server address.');
      return;
    }
    setScanned(true);
    setApiBaseUrl(text).then(() => navigation.goBack());
  };

  if (!permission) {
    return <View style={[styles.center, { backgroundColor: colors.bg }]} />;
  }

  if (!permission.granted) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <Text style={[styles.message, { color: colors.text }]}>
          Camera access is needed to scan the QR code shown by the web UI.
        </Text>
        <Pressable onPress={requestPermission} style={[styles.button, { backgroundColor: colors.primary }]}>
          <Text style={styles.buttonText}>Grant camera access</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : onScanned}
      />
      <View style={styles.overlay}>
        <View style={styles.frame} />
        <Text style={styles.hint}>Point the camera at the QR code on the web page</Text>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  message: { textAlign: 'center', fontSize: 14, lineHeight: 20 },
  button: { borderRadius: 10, paddingVertical: 12, paddingHorizontal: 20 },
  buttonText: { color: '#04121f', fontWeight: '700' },
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    paddingHorizontal: 24,
  },
  frame: {
    width: 220,
    height: 220,
    borderRadius: 16,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.85)',
    marginBottom: 20,
  },
  hint: { color: '#fff', textAlign: 'center', fontSize: 13 },
  errorText: { color: '#f87171', textAlign: 'center', marginTop: 10, fontSize: 13 },
});
