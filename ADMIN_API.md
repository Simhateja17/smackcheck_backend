# SmackCheck Admin API

The admin panel should use the shared Express backend under `/api/admin`.
Every endpoint requires a Supabase bearer token for a user whose
`profiles.is_admin` value is `true`.

## Safety model

Admin actions do not hard-delete records.

- User actions update `profiles.account_status`.
- Rating, comment, and story actions update `content_status`.
- Report actions update `reports.status`.
- Restaurant and dish actions update `catalog_status`.
- Every action writes a row to `moderation_actions`.

In simple terms, admins move records between labeled buckets and the backend
keeps a receipt of who moved what, when, and why.

## Screens and endpoints

- Dashboard: `GET /api/admin/dashboard`
- Users: `GET /api/admin/users`, `GET /api/admin/users/:id`
- User action: `POST /api/admin/users/:id/action`
- Reports: `GET /api/admin/reports`, `GET /api/admin/reports/:id`
- Report status: `PATCH /api/admin/reports/:id/status`
- Apply report action: `POST /api/admin/reports/:id/action`
- Content moderation: `GET /api/admin/content?type=rating|comment|story`
- Content action: `POST /api/admin/content/:type/:id/action`
- Restaurants: `GET /api/admin/restaurants`
- Restaurant status: `PATCH /api/admin/restaurants/:id/status`
- Dishes: `GET /api/admin/dishes`
- Dish status: `PATCH /api/admin/dishes/:id/status`
- Notification campaigns: `GET /api/admin/notifications`
- Broadcast notification: `POST /api/admin/notifications/broadcast`
- Badges: `GET /api/admin/badges`
- Challenges: `GET /api/admin/challenges`
- Audit logs: `GET /api/admin/logs`
- Analytics: `GET /api/admin/analytics`

## Action examples

Suspend a user without deleting the account:

```http
POST /api/admin/users/user_123/action
Authorization: Bearer <supabase-access-token>
Content-Type: application/json

{
  "action": "suspend",
  "reason": "Repeated harassment reports"
}
```

Hide a reported rating and resolve the report:

```http
POST /api/admin/reports/report_123/action
Authorization: Bearer <supabase-access-token>
Content-Type: application/json

{
  "action": "hide",
  "reason": "Contains personal information"
}
```

Broadcast to all active users:

```http
POST /api/admin/notifications/broadcast
Authorization: Bearer <supabase-access-token>
Content-Type: application/json

{
  "title": "New challenge is live",
  "body": "Rate three dishes this week to earn bonus XP."
}
```
