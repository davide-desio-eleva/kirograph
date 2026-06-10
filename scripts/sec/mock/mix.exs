defmodule MockApp.MixProject do
  use Mix.Project

  def project do
    [
      app: :mock_app,
      version: "0.1.0",
      elixir: "~> 1.15",
      deps: deps()
    ]
  end

  def application do
    [extra_applications: [:logger]]
  end

  defp deps do
    [
      {:phoenix, "~> 1.7.0"},
      {:ecto, "~> 3.11"},
      {:ex_machina, "~> 2.7", only: [:dev, :test]}
    ]
  end
end
