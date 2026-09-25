import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PlayerHost } from './src/components/PlayerHost';
import { DownloadsProvider } from './src/downloads/DownloadsContext';
import { RootStackParamList } from './src/navigation';
import { PlayerProvider } from './src/player/PlayerContext';
import { ScanQrScreen } from './src/screens/ScanQrScreen';
import { SearchScreen } from './src/screens/SearchScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { palettes, ThemeProvider, useTheme } from './src/theme/theme';

const Stack = createNativeStackNavigator<RootStackParamList>();

function Navigator() {
  const { theme, colors } = useTheme();
  const navTheme = theme === 'dark' ? DarkTheme : DefaultTheme;

  return (
    <NavigationContainer
      theme={{
        ...navTheme,
        colors: { ...navTheme.colors, background: colors.bg, card: colors.panel, text: colors.text, border: colors.border, primary: colors.primary },
      }}
    >
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Search" component={SearchScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ headerShown: true, title: 'Settings' }} />
        <Stack.Screen
          name="ScanQr"
          component={ScanQrScreen}
          options={{ headerShown: true, title: 'Scan QR', presentation: 'modal' }}
        />
      </Stack.Navigator>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <DownloadsProvider>
          <PlayerProvider>
            {/* The player sits above the navigator so it stays visible (as the
                mini bar) while you move around the app. */}
            <View style={{ flex: 1 }}>
              <Navigator />
              <PlayerHost />
            </View>
          </PlayerProvider>
        </DownloadsProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
