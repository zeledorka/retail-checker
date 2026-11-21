/** Prints an anonymous user's access token onto terminal - this remains temporary and 
 *  is used for the requests.http @token = ... line. This expires every hour and each generation
 * counts as a new user.
*/
import { createClient } from '@supabase/supabase-js';

// `await` is only allowed inside an `async` function in this project's setup,
// so all the work goes inside main() to avoid errors
async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;

  console.log(data.session!.access_token);
}

// Run main(). If anything throws, print the error and exit with a failure code
// (exit code 1 tells the terminal/CI that the script failed).
main().catch((e) => {
  console.error(e);
  process.exit(1);
});