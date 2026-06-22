# GitLab Duo OpenAI-compatible adapter PoC

Adapter ini mengekspos subset OpenAI-compatible API untuk dipakai oleh 9Router:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/chat/completions` dengan `stream: true` memakai SSE

## Cara konfigurasi

Jalankan server:

```bash
npm start
```

Buka:

```text
http://localhost:3000/
```

Paste full POSIX `curl` WebSocket dari DevTools ke textarea, lalu klik **Simpan konfigurasi curl**.

Server akan mem-parse sendiri:

- URL `wss://.../api/v4/ai/duo_workflows/ws?...`
- `User-Agent`
- `Origin`
- `Cookie`
- header lain yang relevan

Header WebSocket hop-by-hop seperti `Sec-WebSocket-Key`, `Connection`, `Upgrade`, dan `Sec-WebSocket-Version` sengaja diabaikan karena dibuat otomatis oleh library `ws`.

API key adapter default:

```text
sk-rizky
```

## Contoh curl untuk adapter lokal

Model list:

```bash
curl 'http://localhost:3000/v1/models' \
  -H 'Authorization: Bearer sk-rizky'
```

Chat non-streaming:

```bash
curl 'http://localhost:3000/v1/chat/completions' \
  -H 'Authorization: Bearer sk-rizky' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gitlab-duo-claude-opus-4-8-bedrock","messages":[{"role":"user","content":"Hello"}]}'
```

Chat streaming SSE:

```bash
curl 'http://localhost:3000/v1/chat/completions' \
  -H 'Authorization: Bearer sk-rizky' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gitlab-duo-claude-opus-4-8-bedrock","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

## Status protokol

Yang sudah terverifikasi dari DevTools:

- GitLab Duo membuka WebSocket ke `/api/v4/ai/duo_workflows/ws`.
- Query string membawa konteks workflow, namespace, model identifier, workflow definition, workflow id, dan client type.
- Browser memakai origin `https://gitlab.com` dan autentikasi berbasis session/cookie.

Yang masih asumsi di PoC ini:

- Format frame client setelah WebSocket terbuka.
- Format frame server untuk token/delta/final response.
- Lifecycle workflow creation sebelum `workflow_id` valid.
- Apakah GitLab Duo menerima replay frame dari non-browser client.

Karena format frame belum diketahui, `src/duoProtocol.js` memakai parser JSON generik dan start frame placeholder. Setelah frame asli diketahui, edit `DuoProtocol.buildStartFrames()` dan `DuoProtocol.parseFrame()`.

## Struktur

- `server.js`: Express app, halaman `/`, endpoint OpenAI-compatible.
- `src/config.js`: default lokal minimal.
- `src/curlParser.js`: parser POSIX curl dari DevTools.
- `src/duoClient.js`: WebSocket lifecycle dan async iterator streaming.
- `src/duoProtocol.js`: builder frame outbound dan parser frame inbound.
- `src/openai.js`: helper response OpenAI-compatible dan SSE.

## Rekap pekerjaan

Berikut rangkuman pekerjaan yang sudah dilakukan selama eksplorasi adapter GitLab Duo ini.

### 1. Membuat adapter OpenAI-compatible

Proyek ini dibuat sebagai proof of concept adapter lokal agar GitLab Duo Chat bisa dipakai oleh aplikasi yang berbicara dengan format OpenAI-compatible API, seperti 9Router.

Endpoint yang sudah disiapkan:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/chat/completions` dengan `stream: true` menggunakan Server-Sent Events/SSE

Server lokal berjalan di:

```text
http://localhost:3000
```

API key lokal default:

```text
sk-rizky
```

### 2. Membuat halaman konfigurasi curl

Halaman `/` dibuat untuk menerima paste full `curl` dari DevTools GitLab. Tujuannya supaya adapter bisa mengambil konfigurasi session GitLab yang valid tanpa hardcode credential di source code.

Data yang diparse dari curl antara lain:

- URL WebSocket GitLab Duo
- `Cookie`
- `User-Agent`
- `Origin`
- header GraphQL yang dibutuhkan
- parameter namespace dan model dari query string WebSocket

Header WebSocket hop-by-hop seperti `Sec-WebSocket-Key`, `Connection`, `Upgrade`, dan `Sec-WebSocket-Version` sengaja tidak dipakai ulang karena harus dibuat otomatis oleh library WebSocket.

### 3. Mengembangkan parser curl

`src/curlParser.js` dikembangkan untuk membaca curl dari browser DevTools, termasuk beberapa format yang muncul saat copy request dari Firefox.

Kemampuan yang sudah ditambahkan:

- parsing multi-curl dalam satu paste
- parsing POSIX shell quoting
- dukungan ANSI-C quoting seperti `$'...'`
- membaca `--data-raw`
- membedakan curl WebSocket dan curl GraphQL
- meredaksi credential sensitif saat ditampilkan di UI

### 4. Menemukan bahwa goal tidak dikirim lewat WebSocket

Awalnya adapter mencoba mengirim beberapa bentuk payload JSON langsung ke WebSocket, misalnya:

```json
{"goal":"USER: ..."}
```

Namun hasil testing menunjukkan GitLab Duo menutup koneksi WebSocket dengan normal close code `1000` tanpa mengirim frame response.

Contoh log yang ditemukan:

```text
[gitlab-duo:attempt:error] goal-only GitLab Duo WebSocket closed without assistant text.
Diagnostics: {"frameCount":0,"closeCode":1000,"closeReason":"","recentEvents":[]}
```

Kesimpulan: pesan user/goal tidak dikirim sebagai frame WebSocket langsung.

### 5. Menganalisis HAR dari browser

File HAR dari DevTools digunakan untuk mencari alur asli GitLab Duo Chat.

File yang dianalisis:

- `gitlab.com_Archive [26-06-21 23-38-00].har`
- `new.har`

Dari HAR ditemukan bahwa saat membuat topik/chat baru, browser melakukan GraphQL mutation:

```text
operationName: createAiDuoWorkflow
```

Mutation tersebut mengirim `goal`, `workflowDefinition`, `namespaceId`, dan privilege agent. Setelah mutation sukses, GitLab mengembalikan workflow baru dengan format:

```text
gid://gitlab/Ai::DuoWorkflows::Workflow/<workflow_id>
```

Setelah itu browser membuka WebSocket menggunakan `workflow_id` baru tersebut.

Kesimpulan penting:

1. Buat workflow baru lewat GraphQL `aiDuoWorkflowCreate`.
2. Ambil numeric workflow id dari response.
3. Buka WebSocket dengan `workflow_id` baru.
4. Gunakan checkpoint/WS untuk membaca jawaban assistant.

### 6. Menambahkan client GraphQL checkpoint

`src/checkpointClient.js` dibuat untuk memanggil GraphQL query:

```text
getWorkflowLatestCheckpoint
```

Query ini mengambil `latestCheckpoint.duoMessages`, lalu adapter mencari pesan assistant terbaru dengan kriteria:

- `messageType` / `message_type` bernilai `agent`
- `status` bernilai `success`
- memiliki `content`

Fallback checkpoint ini penting karena WebSocket tidak selalu langsung memberikan delta token yang mudah diparse.

### 7. Menambahkan parser checkpoint dan frame Duo

`src/duoProtocol.js` dibuat untuk membaca beberapa bentuk response dari GitLab Duo, termasuk nested JSON di field:

```text
newCheckpoint.checkpoint
```

Isi checkpoint tersebut dapat berisi:

```text
channel_values.ui_chat_log
```

Dari sana adapter mengambil pesan agent/assistant dan mengubahnya menjadi delta response OpenAI-compatible.

### 8. Menambahkan workflow creator

`src/workflowCreator.js` dibuat untuk membuat workflow baru lewat GraphQL mutation `aiDuoWorkflowCreate`.

Input utama yang digunakan:

- `namespaceId`
- `environment: WEB`
- `goal`
- `workflowDefinition: chat`
- `agentPrivileges: [2, 3, 7]`
- `preApprovedAgentPrivileges: [2]`
- `allowAgentToRequestUser: true`

Nilai `namespaceId` dibuat dalam bentuk full GitLab GID:

```text
gid://gitlab/Group/<namespace_id>
```

### 9. Mengubah strategi dari replay WebSocket menjadi create-and-listen

Strategi lama:

1. Pakai `workflow_id` dari curl browser.
2. Kirim goal langsung ke WebSocket.
3. Tunggu frame response.

Strategi ini gagal karena WebSocket ditutup tanpa response.

Strategi baru:

1. Buat workflow baru lewat GraphQL mutation.
2. Replace `workflow_id` di URL WebSocket dengan workflow baru.
3. Buka WebSocket sebagai listener.
4. Ambil jawaban dari frame WebSocket atau fallback polling checkpoint.

### 10. Menambahkan endpoint debug GraphQL

`src/graphqlProbe.js` dan endpoint debug ditambahkan untuk membantu cek schema GraphQL GitLab saat dibutuhkan.

Endpoint debug menggunakan auth adapter lokal dan berguna untuk introspeksi ketika shape GraphQL berubah.

### 11. Masalah terakhir yang ditemukan

Error terakhir yang muncul:

```text
[GitLab Duo adapter error: GraphQL curl belum dikonfigurasi (dibutuhkan untuk aiDuoWorkflowCreate)]
```

Artinya adapter belum memiliki konfigurasi GraphQL yang dibutuhkan untuk membuat workflow baru.

Kemungkinan penyebab:

1. Server baru direstart sehingga konfigurasi in-memory hilang.
2. Yang dipaste hanya curl WebSocket, bukan curl GraphQL.
3. Curl GraphQL yang dipaste adalah mutation `createAiDuoWorkflow`, tetapi parser saat itu hanya mengenali GraphQL checkpoint seperti `getWorkflowLatestCheckpoint` / `duoWorkflowWorkflows`.

Catatan penting: konfigurasi saat ini masih disimpan di memory. Jadi setiap `node server.js` direstart, curl perlu dipaste ulang.

### 12. Status saat ini

Yang sudah berhasil diketahui:

- endpoint GitLab Duo WebSocket benar
- session/cookie dari browser bisa dipakai untuk handshake WebSocket
- GraphQL checkpoint bisa membaca riwayat jawaban assistant
- workflow baru harus dibuat lewat GraphQL mutation, bukan lewat frame WebSocket
- response assistant dapat ditemukan di `latestCheckpoint.duoMessages`

Yang masih perlu dirapikan:

- UI perlu menampilkan status `websocket` dan `graphql` secara terpisah
- error message perlu menjelaskan bahwa user harus paste curl WebSocket dan curl GraphQL
- parser curl perlu menerima GraphQL `createAiDuoWorkflow` sebagai konfigurasi valid
- perlu validasi end-to-end setelah paste kedua curl dan restart server
- README lama masih punya beberapa bagian yang menyebut frame WebSocket sebagai asumsi; bagian itu perlu disesuaikan jika flow baru sudah final
