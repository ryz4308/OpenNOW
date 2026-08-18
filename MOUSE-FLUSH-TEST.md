# OpenNOW mouse flush A/B test

This branch changes only the Chromium WebRTC mouse flush preference. It does
not change bitrate control, SDP, video buffering, decoding, or the native
streamer.

## Build

1. Push this branch to a GitHub fork as `mouse-flush-test`.
2. Open **Actions → Mouse flush test build**.
3. If the push did not start it automatically, choose **Run workflow**.
4. Download the `OpenNOW-mouse-flush-test-windows-x64` artifact and extract the
   portable `.exe`.

## Short test

Keep the same game, server, resolution, FPS, codec, bitrate, Wi-Fi settings,
and in-game scene for both runs.

1. Open **Settings → Input → Mouse → Mouse Flush Interval**.
2. Select **4 ms**, start a fresh stream, play for 5 minutes, and save the
   diagnostics log.
3. End the stream.
4. Select **16 ms**, start a fresh stream, repeat the same actions for 5
   minutes, and save the diagnostics log.
5. Confirm the HUD advanced diagnostics says `Mouse flush 4ms` in the first
   run and `Mouse flush 16ms` in the second.

The useful comparison is freeze count/duration, packet-loss bursts, RTT spikes,
stream FPS drops, and whether those events coincide with mouse movement. Mouse
smoothness is secondary for this experiment.
