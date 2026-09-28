// Config plugin: two changes to expo-audio's Android media session that it
// doesn't support out of the box.
//
// 1. Next / Previous on the notification, lock screen and headset buttons.
//    expo-audio's session removes the track-navigation commands and its
//    single-track player never advertises them, so Android draws Previous /
//    Next greyed out. The play queue lives in JS (src/player/queue.ts), so
//    the native side only needs to say "next" / "previous" was pressed.
//
// 2. A progress bar on the notification. expo-audio only learns a track's
//    duration once the player has parsed enough of the stream, which can be
//    well after the notification first appears - until then Android has
//    nothing to draw and the progress line stays empty. The app already
//    knows the video's length (from search results) before playback starts,
//    so this lets it pass that through as a hint (Metadata.durationMs) that
//    the notification can show immediately.
//
// It edits five files (three Kotlin, one Kotlin record, one .d.ts) in
// node_modules/expo-audio while the native project is generated (EAS runs
// this before compiling, and it also runs on `expo prebuild` locally). It is
// idempotent, and it THROWS if expo-audio's code no longer matches (e.g.
// after an upgrade), so a build can never silently ship without these.
//
// expo-audio also ships a precompiled AAR for Android and, by default,
// autolinking links THAT instead of compiling this (patched) source - so
// none of this has any effect unless the app's package.json also forces
// expo-audio to build from source:
//   "expo": { "autolinking": { "android": { "buildFromSource": ["expo-audio"] } } }
// (already set in mobile/package.json). Verify with `cd android && ./gradlew
// projects`: expo-audio must appear as a real project pointing at
// node_modules/expo-audio/android, not be missing from the list.
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = 'Gil Tube patch';

// Paths are relative to expo-audio's package root.
const FILES = {
  'android/src/main/java/expo/modules/audio/service/MetadataInjectingPlayer.kt': [
    [
      `internal class MetadataInjectingPlayer(
  player: Player
) : ForwardingPlayer(player) {`,
      `internal class MetadataInjectingPlayer(
  player: Player,
  // Called with "next" or "previous" when the notification / lock screen /
  // headset asks for another track. Gil Tube patch: the app owns the queue.
  private val onRemoteCommand: (String) -> Unit
) : ForwardingPlayer(player) {`,
    ],
    [
      `  override fun getMediaMetadata(): MediaMetadata {`,
      `  // Gil Tube patch: always offer next / previous. ExoPlayer only reports them for
  // multi-item playlists, and this player holds a single track; the queue lives
  // in JavaScript.
  override fun getAvailableCommands(): Player.Commands {
    return super.getAvailableCommands().buildUpon()
      .add(Player.COMMAND_SEEK_TO_NEXT)
      .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
      .add(Player.COMMAND_SEEK_TO_PREVIOUS)
      .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
      .build()
  }

  override fun isCommandAvailable(command: Int): Boolean {
    return availableCommands.contains(command)
  }

  override fun hasNextMediaItem(): Boolean = true

  override fun hasPreviousMediaItem(): Boolean = true

  override fun seekToNext() = onRemoteCommand("next")

  override fun seekToNextMediaItem() = onRemoteCommand("next")

  override fun seekToPrevious() = onRemoteCommand("previous")

  override fun seekToPreviousMediaItem() = onRemoteCommand("previous")

  override fun getMediaMetadata(): MediaMetadata {`,
    ],
    [
      `      .setArtworkUri(metadata?.artworkUrl?.toString()?.toUri())
      .setArtworkData(null, null)
      .build()`,
      `      .setArtworkUri(metadata?.artworkUrl?.toString()?.toUri())
      .setArtworkData(null, null)
      // Gil Tube patch: a duration hint from the app, shown on the notification
      // before (or in case) the player itself has parsed one from the stream.
      .setDurationMs(metadata?.durationMs)
      .build()`,
    ],
  ],

  'android/src/main/java/expo/modules/audio/service/AudioMediaSessionCallback.kt': [
    [
      `            // Remove track navigation commands
            .remove(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
            .remove(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
            .remove(Player.COMMAND_SEEK_TO_PREVIOUS)
            .remove(Player.COMMAND_SEEK_TO_NEXT)
`,
      `            // Gil Tube patch: keep track navigation; the app handles it
            .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
            .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
            .add(Player.COMMAND_SEEK_TO_PREVIOUS)
            .add(Player.COMMAND_SEEK_TO_NEXT)
`,
    ],
  ],

  'android/src/main/java/expo/modules/audio/service/AudioControlsService.kt': [
    [
      `        ACTION_SEEK_FORWARD -> currentPlayerRef.seekTo(currentPlayerRef.currentPosition + SEEK_INTERVAL_MS)`,
      `        ACTION_NEXT -> currentPlayer?.let { emitRemoteCommand(it, "next") }
        ACTION_PREVIOUS -> currentPlayer?.let { emitRemoteCommand(it, "previous") }
        ACTION_SEEK_FORWARD -> currentPlayerRef.seekTo(currentPlayerRef.currentPosition + SEEK_INTERVAL_MS)`,
    ],
    [
      `  private fun ensureForegroundNotification() {`,
      `  // Gil Tube patch: tell JavaScript the user pressed next / previous.
  private fun emitRemoteCommand(player: AudioPlayer, command: String) {
    player.emit("remoteCommand", mapOf("command" to command))
  }

  private fun ensureForegroundNotification() {`,
    ],
    [
      `      builder.addAction(
        NotificationCompat.Action(
          if (session.player.isPlaying) {`,
      `      builder.addAction(
        NotificationCompat.Action(
          android.R.drawable.ic_media_previous,
          "Previous",
          buildActionPendingIntent(ACTION_PREVIOUS)
        )
      )
      compactViewIndices.add(currentIndex)
      currentIndex++

      builder.addAction(
        NotificationCompat.Action(
          if (session.player.isPlaying) {`,
    ],
    [
      `      compactViewIndices.add(currentIndex)
      currentIndex++

      if (currentOptions?.showSeekForward == true) {`,
      `      compactViewIndices.add(currentIndex)
      currentIndex++

      builder.addAction(
        NotificationCompat.Action(
          android.R.drawable.ic_media_next,
          "Next",
          buildActionPendingIntent(ACTION_NEXT)
        )
      )
      compactViewIndices.add(currentIndex)
      currentIndex++

      if (currentOptions?.showSeekForward == true) {`,
    ],
    [
      `        val sessionPlayer = MetadataInjectingPlayer(resolveSessionPlayer(player, options)).apply {`,
      `        val sessionPlayer = MetadataInjectingPlayer(resolveSessionPlayer(player, options)) { command ->
          emitRemoteCommand(player, command)
        }.apply {`,
      2,
    ],
    [
      `    private const val ACTION_TOGGLE = "expo.modules.audio.action.TOGGLE"
`,
      `    private const val ACTION_TOGGLE = "expo.modules.audio.action.TOGGLE"
    private const val ACTION_NEXT = "expo.modules.audio.action.NEXT"
    private const val ACTION_PREVIOUS = "expo.modules.audio.action.PREVIOUS"
`,
    ],
  ],

  'android/src/main/java/expo/modules/audio/AudioRecords.kt': [
    [
      `@OptimizedRecord
class Metadata(
  @Field val title: String?,
  @Field val artist: String?,
  @Field val albumTitle: String?,
  @Field val artworkUrl: URL?
) : Record`,
      `@OptimizedRecord
class Metadata(
  @Field val title: String?,
  @Field val artist: String?,
  @Field val albumTitle: String?,
  @Field val artworkUrl: URL?,
  // Gil Tube patch: a duration hint (ms) shown on the notification before the
  // player itself has parsed one from the stream. See MetadataInjectingPlayer.
  @Field val durationMs: Long? = null
) : Record`,
    ],
  ],

  // JS/TS is not compiled by Gradle, so buildFromSource doesn't matter here -
  // Metro bundles straight from node_modules, and this runs before that.
  'build/Audio.types.d.ts': [
    [
      `export type AudioMetadata = {
    title?: string;
    artist?: string;
    albumTitle?: string;
    artworkUrl?: string;
};`,
      `export type AudioMetadata = {
    title?: string;
    artist?: string;
    albumTitle?: string;
    artworkUrl?: string;
    /** Gil Tube patch: duration hint (ms) for the notification's progress bar. */
    durationMs?: number;
};`,
    ],
  ],
};

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// Applies the edits under `packageDir` (expo-audio's package root). Returns
// the paths changed; throws if a file doesn't look as expected.
function applyEdits(packageDir) {
  const changed = [];
  for (const [relPath, edits] of Object.entries(FILES)) {
    const file = path.join(packageDir, relPath);
    if (!fs.existsSync(file)) throw new Error(`withAudioRemoteCommands: ${file} not found (expo-audio layout changed?)`);
    const original = fs.readFileSync(file, 'utf8');
    const usesCrlf = original.includes('\r\n');
    let text = original.replace(/\r\n/g, '\n');
    if (text.includes(MARKER)) continue; // already patched

    for (const [from, to, expected = 1] of edits) {
      const found = count(text, from);
      if (found !== expected) {
        throw new Error(
          `withAudioRemoteCommands: expected ${expected} match(es) in ${relPath} but found ${found} for:\n${from.slice(0, 120)}\n` +
            'expo-audio changed; update plugins/withAudioRemoteCommands.js.',
        );
      }
      text = text.split(from).join(to);
    }
    fs.writeFileSync(file, usesCrlf ? text.replace(/\n/g, '\r\n') : text);
    changed.push(relPath);
  }
  return changed;
}

function packageDirFor(projectRoot) {
  const pkg = require.resolve('expo-audio/package.json', { paths: [projectRoot] });
  return path.dirname(pkg);
}

const withAudioRemoteCommands = (config) =>
  withDangerousMod(config, [
    'android',
    (cfg) => {
      const changed = applyEdits(packageDirFor(cfg.modRequest.projectRoot));
      console.log(
        changed.length
          ? `withAudioRemoteCommands: patched expo-audio (${changed.join(', ')})`
          : 'withAudioRemoteCommands: expo-audio already patched',
      );
      return cfg;
    },
  ]);

module.exports = withAudioRemoteCommands;
module.exports.applyEdits = applyEdits;
module.exports.packageDirFor = packageDirFor;
