# syntax=docker/dockerfile:1
#
# Caddy with the Cloudflare DNS module.
#
# The stock image cannot get a WILDCARD certificate. Let's Encrypt only issues
# `*.example.com` against a DNS-01 challenge — proving control of the domain by
# writing a TXT record — and the stock binary ships no DNS provider plugins.
# One wildcard certificate is what lets a new tenant work the moment its row
# exists, with no per-subdomain certificate dance.
#
# Swap the module if your DNS is elsewhere: the plugin list at
# github.com/caddy-dns has route53, digitalocean, namecheap and the rest.

FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
