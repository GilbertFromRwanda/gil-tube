// Config plugin: makes expo-audio's Android media session offer Next / Previous
// (notification, lock screen, headset buttons) and report presses to JavaScript
// as a 'remoteCommand' event on the player.
//
// Why: expo-audio's session removes the track-navigation commands and its
// single-track player never advertises them, so Android draws Previous / Next
// greyed out. The play queue lives in JS (src/player/queue.ts), so the native
// side only needs to say "next" / "previous" was pressed.
//
// It edits the three Kotlin files in node_modules/expo-audio while the native
// project is generated (EAS runs this before compiling). It is idempotent, and
// it THROWS if expo-audio's code no longer matches (e.g. after an upgrade), so a
// build can never silently ship without the buttons working.
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = 'Gil Tube patch';

const EDITS = {
  'MetadataInjectingPlayer.kt': [
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
  ],

  'AudioMediaSessionCallback.kt': [
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

  'AudioControlsService.kt': [
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
};

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// Applies the edits under `serviceDir` (…/expo/modules/audio/service). Returns the
// names of files changed; throws if a file doesn't look as expected.
function applyEdits(serviceDir) {
  const changed = [];
  for (const [name, edits] of Object.entries(EDITS)) {
    const file = path.join(serviceDir, name);
    if (!fs.existsSync(file)) throw new Error(`withAudioRemoteCommands: ${file} not found (expo-audio layout changed?)`);
    const original = fs.readFileSync(file, 'utf8');
    const usesCrlf = original.includes('\r\n');
    let text = original.replace(/\r\n/g, '\n');
    if (text.includes(MARKER)) continue; // already patched

    for (const [from, to, expected = 1] of edits) {
      const found = count(text, from);
      if (found !== expected) {
        throw new Error(
          `withAudioRemoteCommands: expected ${expected} match(es) in ${name} but found ${found} for:\n${from.slice(0, 120)}\n` +
            'expo-audio changed; update plugins/withAudioRemoteCommands.js.',
        );
      }
      text = text.split(from).join(to);
    }
    fs.writeFileSync(file, usesCrlf ? text.replace(/\n/g, '\r\n') : text);
    changed.push(name);
  }
  return changed;
}

function serviceDirFor(projectRoot) {
  const pkg = require.resolve('expo-audio/package.json', { paths: [projectRoot] });
  return path.join(path.dirname(pkg), 'android/src/main/java/expo/modules/audio/service');
}

const withAudioRemoteCommands = (config) =>
  withDangerousMod(config, [
    'android',
    (cfg) => {
      const changed = applyEdits(serviceDirFor(cfg.modRequest.projectRoot));
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
module.exports.serviceDirFor = serviceDirFor;
