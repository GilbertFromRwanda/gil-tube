// Extends app.json with details that only exist at build time, so a running
// app (and Settings > Version) can say exactly which build it is. EAS exposes
// the commit being built as EAS_BUILD_GIT_COMMIT_HASH; locally it's unset.
module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    gitCommit: (process.env.EAS_BUILD_GIT_COMMIT_HASH || '').slice(0, 7) || undefined,
    builtAt: new Date().toISOString(),
  },
});
