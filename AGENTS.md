# Project Notes

- WebSocket payloads with `type: "message"` must set `data.name` to the sender's nickname.
- For incoming friend messages, `data.name` is the friend's nickname.
- For self-sent echo messages, `data.name` is the current Steam account nickname.
