import { audit } from "./audit.ts";
import { db } from "./db.server.ts";
import { CATEGORY_NAME_MAX_LENGTH } from "./limits.ts";
import { UserInputError, getUser } from "./users.ts";

/**
 * Employee categories: named groups of people ("Field", "Shop") used to
 * filter timesheets and reports, and to give a group a default rate
 * (rates.ts, scope "category"). A person is in at most one category.
 */

export interface Category {
  id: number;
  name: string;
  /** Active people currently in the category. */
  peopleCount: number;
}

export function listCategories(): Category[] {
  return db()
    .query<{ id: number; name: string; people: number }, []>(
      `SELECT c.id, c.name,
              (SELECT COUNT(*) FROM users u WHERE u.category_id = c.id AND u.active = 1) AS people
         FROM employee_categories c
        ORDER BY c.name COLLATE NOCASE`,
    )
    .all()
    .map((r) => ({ id: r.id, name: r.name, peopleCount: r.people }));
}

export function getCategory(id: number): Category | null {
  return listCategories().find((c) => c.id === id) ?? null;
}

function normalizeCategoryName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) throw new UserInputError("Name the category.");
  if (name.length > CATEGORY_NAME_MAX_LENGTH) {
    throw new UserInputError(`Category names are limited to ${CATEGORY_NAME_MAX_LENGTH} characters.`);
  }
  return name;
}

function assertNameFree(name: string, exceptId: number | null): void {
  const clash = db()
    .query<{ id: number }, [string, number]>("SELECT id FROM employee_categories WHERE name = ? AND id != ?")
    .get(name, exceptId ?? -1);
  if (clash) throw new UserInputError(`There's already a category called “${name}”.`);
}

export function createCategory(args: { name: string; actorUserId: number; now?: number }): Category {
  const now = args.now ?? Date.now();
  const name = normalizeCategoryName(args.name);
  assertNameFree(name, null);
  const { id } = db()
    .query<{ id: number }, [string, number]>(
      "INSERT INTO employee_categories (name, created_at) VALUES (?, ?) RETURNING id",
    )
    .get(name, now)!;
  audit({ actorUserId: args.actorUserId, entity: "category", entityId: id, action: "create", after: { name }, at: now });
  return getCategory(id)!;
}

export function renameCategory(args: { id: number; name: string; actorUserId: number }): Category {
  const category = mustGet(args.id);
  const name = normalizeCategoryName(args.name);
  if (name === category.name) return category;
  assertNameFree(name, category.id);
  db().query("UPDATE employee_categories SET name = ? WHERE id = ?").run(name, category.id);
  audit({
    actorUserId: args.actorUserId,
    entity: "category",
    entityId: category.id,
    action: "rename",
    before: { name: category.name },
    after: { name },
  });
  return mustGet(category.id);
}

/**
 * Delete a category. Its people become uncategorised and its rates go with
 * it; approved time keeps the rate it was approved at. The audit entry lists
 * what was removed.
 */
export function deleteCategory(args: { id: number; actorUserId: number }): Category {
  const category = mustGet(args.id);
  db().transaction(() => {
    const people = db()
      .query<{ id: number }, [number]>("SELECT id FROM users WHERE category_id = ?")
      .all(category.id)
      .map((r) => r.id);
    const rates = db()
      .query<{ hourly_rate: number; effective_from: string }, [number]>(
        "SELECT hourly_rate, effective_from FROM rates WHERE category_id = ? AND deleted_at IS NULL",
      )
      .all(category.id);
    db().query("DELETE FROM employee_categories WHERE id = ?").run(category.id);
    audit({
      actorUserId: args.actorUserId,
      entity: "category",
      entityId: category.id,
      action: "delete",
      before: { name: category.name, people, rates },
    });
  })();
  return category;
}

/** Put a person in a category, or take them out of one (`categoryId: null`). */
export function setUserCategory(args: { userId: number; categoryId: number | null; actorUserId: number }): void {
  const user = getUser(args.userId);
  if (!user) throw new UserInputError("That person no longer exists.");
  if (args.categoryId != null) mustGet(args.categoryId);
  if (user.categoryId === args.categoryId) return;
  db()
    .query("UPDATE users SET category_id = ?, updated_at = ? WHERE id = ?")
    .run(args.categoryId, Date.now(), user.id);
  audit({
    actorUserId: args.actorUserId,
    entity: "user",
    entityId: user.id,
    action: "category",
    before: { categoryId: user.categoryId },
    after: { categoryId: args.categoryId },
  });
}

function mustGet(id: number): Category {
  const category = getCategory(id);
  if (!category) throw new UserInputError("That category no longer exists.");
  return category;
}
