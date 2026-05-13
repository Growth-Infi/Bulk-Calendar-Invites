import { supabase } from "../lib/supabase.js";
export const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      console.error("ERROR Middlware - No jwt token found in request ");

      return res.status(401).json({
        error: "Unauthorized",
      });
    }
    const token = authHeader.split(" ")[1];
    // console.log("Got token " + token.slice(10));

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      console.error("FAILED Middlware - Supabase Auth for Jwt token ");

      return res.status(401).json({
        error: "Invalid token",
      });
    }
    req.user = user;
    console.log("Verified in middleware ✔️ ");

    next();
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
};
