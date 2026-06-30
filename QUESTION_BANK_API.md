# ExamEdge — Question Bank API Reference
**Base URL:** `http://localhost:3001/api/v1`
All admin endpoints require: `Authorization: Bearer <admin_access_token>`

---

## Taxonomy (Read-only — for form dropdowns)

### GET `/admin/questions/subjects`
List all subjects, optionally filtered by exam.

**Query params:** `exam` (optional) — `NEET | JEE_MAIN | JEE_ADVANCED | CUET`

**Response:**
```json
{
  "success": true,
  "data": {
    "subjects": [
      { "id": "clx...", "name": "Physics", "code": "PHY", "exam": "NEET", "order": 1, "_count": { "questions": 142 } }
    ]
  }
}
```

---

### GET `/admin/questions/subjects/:subjectId/chapters`
List chapters under a subject.

**Response:**
```json
{
  "success": true,
  "data": {
    "chapters": [
      { "id": "clx...", "name": "Kinematics", "order": 2, "_count": { "questions": 18 } }
    ]
  }
}
```

---

### GET `/admin/questions/chapters/:chapterId/topics`
List topics under a chapter.

---

## Stats

### GET `/admin/questions/stats`
Question bank statistics for the admin dashboard.

**Query params:** `exam` (optional)

**Response:**
```json
{
  "success": true,
  "data": {
    "stats": {
      "total": 1420,
      "recentlyAdded": 38,
      "byType": [
        { "type": "MCQ_SINGLE", "count": 900 },
        { "type": "INTEGER", "count": 200 }
      ],
      "byDifficulty": [
        { "difficulty": "EASY", "count": 400 },
        { "difficulty": "MEDIUM", "count": 700 },
        { "difficulty": "HARD", "count": 320 }
      ],
      "byStatus": [
        { "status": "ACTIVE", "count": 1380 },
        { "status": "ARCHIVED", "count": 40 }
      ]
    }
  }
}
```

---

## CRUD

### GET `/admin/questions`
List questions with filters and pagination.

**Query params:**
| Param | Type | Description |
|---|---|---|
| `exam` | string | Filter by exam |
| `subjectId` | string | Filter by subject |
| `chapterId` | string | Filter by chapter |
| `topicId` | string | Filter by topic |
| `type` | string | `MCQ_SINGLE \| MCQ_MULTIPLE \| INTEGER \| ASSERTION \| MATCH_COLUMN` |
| `difficulty` | string | `EASY \| MEDIUM \| HARD` |
| `status` | string | `DRAFT \| ACTIVE \| ARCHIVED` |
| `search` | string | Search in question text |
| `tags` | string | Comma-separated tags |
| `isVerified` | boolean | Filter verified/unverified |
| `page` | number | Default: 1 |
| `pageSize` | number | Default: 20, max: 100 |
| `sortBy` | string | `createdAt \| updatedAt \| difficulty \| usageCount` |
| `sortOrder` | string | `asc \| desc` |

**Note:** `correctAnswer` and `solution` are NOT returned in list view for security.

---

### POST `/admin/questions`
Create a single question.

**Body:**
```json
{
  "exam": "NEET",
  "subjectId": "clx...",
  "chapterId": "clx...",
  "topicId": "clx...",
  "type": "MCQ_SINGLE",
  "difficulty": "MEDIUM",
  "content": {
    "text": "Which organelle is known as the powerhouse of the cell?",
    "imageUrl": null
  },
  "options": [
    { "id": "A", "text": "Nucleus", "imageUrl": null },
    { "id": "B", "text": "Mitochondria", "imageUrl": null },
    { "id": "C", "text": "Ribosome", "imageUrl": null },
    { "id": "D", "text": "Golgi Body", "imageUrl": null }
  ],
  "correctAnswer": "B",
  "solution": {
    "text": "Mitochondria produces ATP through cellular respiration, earning it the name 'powerhouse of the cell'.",
    "imageUrl": null
  },
  "tags": ["cell biology", "organelles"],
  "sourceYear": 2019,
  "sourceExam": "NEET 2019"
}
```

**Type-specific body examples:**

**MCQ_MULTIPLE:**
```json
{ "correctAnswer": ["A", "C"] }
```

**INTEGER:**
```json
{
  "options": null,
  "correctAnswer": 42
}
```

**ASSERTION:**
```json
{
  "content": {
    "text": null,
    "assertion": "Mitochondria has its own DNA.",
    "reason": "Mitochondria is a semi-autonomous organelle."
  },
  "options": [
    { "id": "A", "text": "Both A and R are true and R is the correct explanation of A" },
    { "id": "B", "text": "Both A and R are true but R is NOT the correct explanation of A" },
    { "id": "C", "text": "A is true but R is false" },
    { "id": "D", "text": "A is false but R is true" }
  ],
  "correctAnswer": "A"
}
```

**MATCH_COLUMN:**
```json
{
  "options": {
    "leftCol":  [{ "id": "1", "text": "Newton" }, { "id": "2", "text": "Ohm" }],
    "rightCol": [{ "id": "P", "text": "Motion" }, { "id": "Q", "text": "Resistance" }]
  },
  "correctAnswer": { "1": "P", "2": "Q" }
}
```

---

### GET `/admin/questions/:id`
Get a single question with full detail including `correctAnswer` and `solution`.

---

### PATCH `/admin/questions/:id`
Update a question. All fields optional.

**Restriction:** If the question is used in one or more tests (`usageCount > 0`), only `tags`, `difficulty`, and `status` can be changed. Content edits require archiving and recreating.

---

### DELETE `/admin/questions/:id`
Soft delete a question. Sets `deletedAt` and status to `ARCHIVED`.

**Restriction:** Questions with `usageCount > 0` cannot be deleted.

---

### POST `/admin/questions/bulk-delete`
Delete multiple questions at once.

**Body:**
```json
{ "questionIds": ["clx...", "clx..."] }
```

---

### PATCH `/admin/questions/:id/verify`
Mark a question as verified/unverified. **Super Admin only.**

**Body:**
```json
{ "isVerified": true }
```

---

## Image Upload

### POST `/admin/questions/upload-image`
Upload an image to S3. Returns a URL to embed in question content.

**Request:** `multipart/form-data` with field `file` (JPEG, PNG, or WebP, max 5MB)

**Response:**
```json
{
  "success": true,
  "data": {
    "url": "https://examedge-assets.s3.ap-south-1.amazonaws.com/question/temp/abc123.jpg",
    "s3Key": "question/temp/abc123.jpg",
    "message": "Image uploaded. Use the URL in your question content."
  }
}
```

---

## Bulk Upload

### GET `/admin/questions/bulk-upload/template`
Download the Excel template (.xlsx). Fill it in and re-upload.

---

### POST `/admin/questions/bulk-upload?exam=NEET`
Upload filled Excel/CSV template.

**Request:** `multipart/form-data` with field `file` (.xlsx or .csv)
**Query:** `exam` (required) — the exam this batch belongs to

**Response (success):**
```json
{
  "success": true,
  "data": {
    "bulkUploadId": "clx...",
    "total": 50,
    "created": 48,
    "failed": 2,
    "errors": [
      {
        "rowNumber": 12,
        "status": "FAILED",
        "errorMessage": "Chapter \"Photosythesis\" not found. Check spelling.",
        "rawData": { "exam": "NEET", "chapter_name": "Photosythesis", "..." : "..." }
      }
    ],
    "message": "48 of 50 questions imported. 2 failed."
  }
}
```

**Response (all failed — HTTP 422):**
```json
{
  "success": false,
  "data": {
    "total": 10,
    "created": 0,
    "failed": 10,
    "errors": [...]
  }
}
```

---

### GET `/admin/questions/bulk-upload/:id`
Get the status and error details of a past upload.

---

### GET `/admin/questions/bulk-uploads`
List all bulk uploads made by the current admin (last 20).

---

## Error Codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Schema validation failed — see `details` for field errors |
| `INVALID_INPUT` | 400 | Bad taxonomy reference, wrong type-answer combination |
| `UNAUTHORIZED` | 401 | Missing or invalid token |
| `FORBIDDEN` | 403 | Not enough role/scope |
| `EXAM_SCOPE_DENIED` | 403 | Admin doesn't manage this exam |
| `QUESTION_NOT_FOUND` | 404 | Question ID doesn't exist or is deleted |
| `CONFLICT` | 409 | Question is used in tests — cannot delete/edit content |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
