connection: "my_bq"

include: "views/shared_dims.view.lkml"
include: "views/orders.view.lkml"

explore: orders {
  join: shared_dims {
    relationship: many_to_one
    sql_on: ${orders.region_id} = ${shared_dims.id} ;;
  }
}
