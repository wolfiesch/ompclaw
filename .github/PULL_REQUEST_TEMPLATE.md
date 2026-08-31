## Summary

Describe the user-visible behavior changed by this pull request and why it belongs in `ompclaw`.

## Architecture impact

- [ ] This preserves one gateway process owning one persistent OMP session.
- [ ] Transport authentication, secret isolation, and the health-only HTTP boundary remain intact.
- [ ] Durable state changes stay within `GatewayStore` and include an appropriate migration or compatibility plan.

## Verification

List the focused commands or scenarios that exercise the changed behavior.

- [ ] I ran the narrowest relevant test while developing.
- [ ] I ran `bun run check` before requesting review.

## Security and provenance

- [ ] This pull request contains no credentials, authorization headers, private paths, or personal data.
- [ ] Configuration contains environment variable names only, not secret values.
- [ ] I did not add a local publishing path, registry token, generated package tarball, or release claim.

## Additional context

Link related issues and describe any follow-up that reviewers need to know.
