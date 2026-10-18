# Local-only TLS tests

Remote desktop smoke tests generate an ephemeral self-signed localhost certificate and key on the runner using OpenSSL. No test private key is committed or bundled. Packaged builds never honor the development-only certificate pin.
