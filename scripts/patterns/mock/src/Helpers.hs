module Helpers where

greet :: String -> String
greet name = "Hello, " ++ name ++ "!"

add :: Int -> Int -> Int
add a b = a + b

data User = User { userId :: Int, userName :: String }

filterUsers :: [User] -> [User]
filterUsers = filter ((> 0) . userId)
