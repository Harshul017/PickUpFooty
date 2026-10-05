import bcrypt from "bcryptjs";
import { db } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "./tokens.js";

export interface SignupInput {
  name: string;
  email?: string;
  phone?: string;
  password: string;
  skillLevel: "BEGINNER" | "CASUAL" | "INTERMEDIATE" | "COMPETITIVE";
}

// Starting rating by self-reported skill level; see design doc "Ratings".
const STARTING_RATING: Record<SignupInput["skillLevel"], number> = {
  BEGINNER: 1000,
  CASUAL: 1150,
  INTERMEDIATE: 1300,
  COMPETITIVE: 1450,
};

export async function signup(input: SignupInput) {
  if (!input.email && !input.phone) {
    throw Errors.badRequest("Provide an email or a phone number");
  }
  const passwordHash = await bcrypt.hash(input.password, 10);

  const result = await db.transaction().execute(async (trx) => {
    const user = await trx
      .insertInto("users")
      .values({
        name: input.name,
        email: input.email ?? null,
        phone: input.phone ?? null,
        password_hash: passwordHash,
        role: "PLAYER",
      })
      .returning(["id", "name", "role"])
      .executeTakeFirstOrThrow();

    await trx
      .insertInto("player_ratings")
      .values({
        user_id: user.id,
        rating: STARTING_RATING[input.skillLevel],
        is_provisional: true,
      })
      .execute();

    return user;
  });

  return issueTokens(result.id, result.role);
}

export async function login(identifier: string, password: string) {
  const user = await db
    .selectFrom("users")
    .selectAll()
    .where((eb) => eb.or([eb("email", "=", identifier), eb("phone", "=", identifier)]))
    .executeTakeFirst();

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw Errors.unauthorized("Invalid credentials");
  }

  return issueTokens(user.id, user.role);
}

export async function refresh(refreshToken: string) {
  let payload: { sub: string };
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw Errors.unauthorized("Invalid or expired refresh token");
  }
  const user = await db
    .selectFrom("users")
    .select(["id", "role"])
    .where("id", "=", payload.sub)
    .executeTakeFirst();
  if (!user) throw Errors.unauthorized("User no longer exists");
  return issueTokens(user.id, user.role);
}

function issueTokens(userId: string, role: "PLAYER" | "ADMIN") {
  return {
    accessToken: signAccessToken({ sub: userId, role }),
    refreshToken: signRefreshToken(userId),
  };
}
